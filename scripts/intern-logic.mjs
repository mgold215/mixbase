// Logic Pro, operated through the helper's Accessibility commands
// (macos/MixbaseIntern/Sources/AX.swift). Everything here was worked out on
// Logic Pro 12.4 with a copy of a real project open; the mixing-intern skill
// lists what was found. No keys are typed and nothing is clicked by position:
// every step presses or sets a named control, so it does not need Logic in
// front. Logic's dialogs do not take typed keys from outside at all.
//
//   const logic = createLogic(helper, { log, tag })
//   await logic.open(copyPath)          the COPY; never the owner's project
//   await logic.bounce(file)            File > Bounce > Project or Section
//   await logic.exportTracks(folder)    File > Export > All Tracks as Audio Files
//   await logic.applyMoves(moves)       a Gain or a Channel EQ, last in the strip
//   await logic.save(); await logic.close()

import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

const sleep = ms => new Promise(r => setTimeout(r, ms))
/** A dialog that has only just appeared ignores presses, and reading it at once can hang: wait this long first. */
const SETTLE_MS = 1500

/**
 * Messages Logic shows by itself that only inform, and are answered OK. Each
 * is one that was met for real; anything else stops the job with its text.
 *  - after a restart or a system update Logic may fall back to another audio
 *    interface ("The last selected audio interface is not available. The
 *    previously selected interface … will be used instead."). A bounce does
 *    not play through the interface.
 */
const NOTICES = [/last selected audio interface is not available/i]

/** A failure the owner should read as it is. */
export class LogicProblem extends Error {}

/** "-2.4 dB", "+0.50 dB", "1040 Hz", "0.60" → the number. */
export function readNumber(text) {
  const m = String(text ?? '').replace(/[−–]/g, '-').replace(/,/g, '').match(/-?\d+(\.\d+)?/)
  return m ? Number(m[0]) : null
}

/** Exported file → track name: "<project> - <track>.wav", and Logic's "_1" for a repeated name is kept. */
export function trackOfFile(file, project) {
  const stem = basename(file, extname(file))
  return stem.startsWith(`${project} - `) ? stem.slice(project.length + 3) : stem
}

/**
 * Which channel strip a track name means. Strip names repeat (three HOOKs), and
 * Logic numbers the exports of a repeated name: "HOOK", "HOOK_1", "HOOK_2", in
 * mixer order. Answers the index into `names`, or -1.
 */
export function stripIndexFor(track, names) {
  const exact = names.indexOf(track)
  const numbered = track.match(/^(.*)_(\d+)$/)
  if (numbered) {
    const same = names.flatMap((n, i) => (n === numbered[1] ? [i] : []))
    // Only when the plain name really repeats: a track can be CALLED "Take_2".
    if (same.length > 1 && same[Number(numbered[2])] != null && exact < 0) return same[Number(numbered[2])]
  }
  return exact
}

/** The names Logic exports a mixer's strips under: a repeated name gets "_1", "_2" in order. */
export function exportNames(names) {
  const seen = new Map()
  return names.map(n => {
    const k = seen.get(n) ?? 0
    seen.set(n, k + 1)
    return k ? `${n}_${k}` : n
  })
}

export function createLogic(helper, { log = () => {}, tag = 'job', onFolder = async () => {}, ownDir = null } = {}) {
  /** One command to the helper. "Too busy" (Logic is mid-task and slow to answer) is asked again, a few times. */
  const ax = async (cmd, args, timeoutMs) => {
    for (let i = 0; ; i++) {
      try { return await helper(cmd, args, timeoutMs) } catch (err) {
        // The window list also fails outright for a moment while a project loads.
        const busy = /too busy/i.test(err.message) || (cmd === 'app.windows' && /cannot complete/i.test(err.message))
        if (i >= 6 || !busy) throw err
        await sleep(4000)
      }
    }
  }
  const find = (el, q) => ax('ax.find', { el, depth: 3, ...q })
  const one = async (el, q) => (await find(el, { ...q, limit: 1 }))[0] ?? null
  /** Logic answers some presses that open a sheet or a menu with an error; the press still happened. */
  const press = async h => {
    try { await ax('ax.act', { el: h }) } catch (err) { if (!/unsupported|cannot complete/i.test(err.message)) throw err }
  }
  const windows = () => ax('app.windows')
  /** A menu item. Right after a project opens its items can still read as greyed out: try for a while. */
  async function menu(path) {
    for (let i = 0; ; i++) {
      try { return await ax('ax.menu', { path }) } catch (err) {
        if (i >= 20 || !/greyed out/.test(err.message)) throw new LogicProblem(`Logic would not do ${path.join(' > ')}: ${err.message}`)
        await sleep(1500)
      }
    }
  }
  const state = { copy: null, project: null, reopen: [], outDirs: [], ours: new Map() }

  async function until(what, fn, { timeout = 60_000, every = 500 } = {}) {
    const end = Date.now() + timeout
    for (;;) {
      const v = await fn()
      if (v) return v
      if (Date.now() > end) throw new LogicProblem(`Logic did not get to "${what}" in ${Math.round(timeout / 1000)} s`)
      await sleep(every)
    }
  }

  // ── Windows that are not the project ──────────────────────────────────────

  const isProgress = async w => w.title === 'Logic Pro' && !!(await one(w.h, { role: 'AXProgressIndicator', depth: 2 }))
  // A plug-in window is known by its own header (the View menu button), looked
  // for among the window's direct children ONLY: reading inside a third-party
  // plug-in's editor can hang for minutes.
  const isPlugin = async w => w.sub === 'AXDialog' && !w.id && !!(await one(w.h, { role: 'AXMenuButton', desc: 'view', depth: 1 }))

  /** An alert Logic is showing, as { text, buttons }, or null. */
  async function alert() {
    for (const w of await windows()) {
      if (w.sub === 'AXStandardWindow' || w.id === 'save-panel' || w.id === 'open-panel') continue
      if (await isProgress(w) || await isPlugin(w)) continue
      if (/^Bounce /.test(w.title)) continue
      const texts = (await find(w.h, { role: 'AXStaticText', limit: 8 })).map(t => t.value).filter(Boolean)
      const buttons = (await find(w.h, { role: 'AXButton', limit: 8 })).filter(b => b.title)
      if (!buttons.length) continue
      const text = texts.join(' ').slice(0, 300)
      // A notice that only informs, and that Logic shows by itself: acknowledged, not a problem.
      const ok = buttons.find(b => b.title === 'OK')
      if (ok && NOTICES.some(re => re.test(text))) {
        log(`Logic said: "${text}" (OK pressed)`)
        await press(ok.h)
        await sleep(800)
        continue
      }
      return { h: w.h, text, buttons }
    }
    return null
  }

  /**
   * Waits while Logic is busy (a bounce, an export, a save). While it works
   * Logic answers slowly or not at all, so "no progress window" is not enough:
   * it is done when the project's window is back, nothing titled "Logic Pro"
   * is in front of it, and that has been seen twice running.
   */
  async function whileBusy(what, timeout) {
    await sleep(1500)
    let calm = 0
    await until(what, async () => {
      const ws = await windows().catch(() => null)
      if (!ws || !ws.some(w => w.sub === 'AXStandardWindow' && docPath(w) === state.copy)) { calm = 0; return false }
      const a = await alert()
      if (a) throw new LogicProblem(`Logic stopped with a message while ${what}: "${a.text}"`)
      // Its progress window, or one it is too busy to describe.
      if (ws.some(w => w.title === 'Logic Pro')) { calm = 0; return false }
      return ++calm >= 2
    }, { timeout, every: 2000 })
  }

  async function closePluginWindows() {
    for (const w of await windows()) {
      if (!(await isPlugin(w))) continue
      const close = await one(w.h, { role: 'AXButton', desc: 'close', depth: 1 })
      if (close) await press(close.h)
    }
  }

  // ── Opening and closing ───────────────────────────────────────────────────

  const docPath = w => (w.document ? decodeURIComponent(String(w.document).replace(/^file:\/\//, '')).replace(/\/$/, '') : null)
  const mainWindow = async () => (await windows()).find(w => w.sub === 'AXStandardWindow' && docPath(w) === state.copy) ?? null

  async function open(copyPath) {
    state.copy = copyPath.replace(/\/$/, '')
    state.project = basename(state.copy, '.logicx')
    const before = await ax('ping')
    if (!before.logic_running) {
      await ax('app.launch')
      await until('start', async () => (await ax('ping')).logic_running, { timeout: 120_000, every: 2000 })
      await sleep(8000)
    }
    // A notice left on screen (see NOTICES) blocks Logic's menus: acknowledge it first.
    await alert().catch(() => null)
    // A copy an earlier job left open (the Mac restarted mid-job, say) is the intern's own: closed, not saved.
    const openNow = (await windows().catch(() => [])).filter(w => w.sub === 'AXStandardWindow').map(docPath).filter(Boolean)
    const stale = ownDir ? openNow.filter(p => p.startsWith(`${ownDir}/`) && p !== state.copy) : []
    if (stale.length) {
      const mine = state.copy
      for (const p of stale) { state.copy = p; await close().catch(err => log(`could not close a stale copy: ${err.message}`)) }
      state.copy = mine
    }
    // Logic closes the project it has open when another is opened. Remember it, to open it again afterwards.
    state.reopen = openNow.filter(p => p !== state.copy && !stale.includes(p))
    await ax('app.open', { path: state.copy })
    await until('the project open', async () => {
      const a = await alert()
      if (a) {
        const names = a.buttons.map(b => b.title)
        // Logic asks whether to save what is open. If that is only the intern's own
        // stale copy (nothing of the owner's was open), it is not saved.
        const dont = a.buttons.find(b => /^don.t save/i.test(b.title))
        if (names.some(n => /^save/i.test(n)) && dont && stale.length && !state.reopen.length) {
          await press(dont.h)
          return false
        }
        // Unsaved work in the project that is open: never answered for the owner.
        if (names.some(n => /^save/i.test(n))) {
          const cancel = a.buttons.find(b => /cancel/i.test(b.title))
          if (cancel) await press(cancel.h)
          throw new LogicProblem('Logic has a project open with unsaved changes. Save or close it on the Mac, then hand the mix over again.')
        }
        throw new LogicProblem(`Logic showed a message while opening the copy: "${a.text}" (${names.join(' / ')})`)
      }
      const w = await mainWindow()
      if (!w) return false
      for (const x of await windows()) if (await isProgress(x)) return false
      return true
    }, { timeout: 300_000, every: 1500 })
    await sleep(2000)
    // A project is saved with whatever plug-in windows were open: they are in the way.
    await closePluginWindows()
    await mixer()
  }

  /** The mixer's strip area, shown if it is hidden. */
  async function mixer() {
    const w = await mainWindow()
    if (!w) throw new LogicProblem('The copy is no longer open in Logic')
    let area = await one(w.h, { role: 'AXLayoutArea', desc: 'Mixer', depth: 3 })
    if (!area) {
      const toggle = await one(w.h, { role: 'AXCheckBox', title: 'Mixer', depth: 3 })
      if (!toggle) throw new LogicProblem('Logic\'s mixer could not be found')
      await press(toggle.h)
      area = await until('the mixer', () => one(w.h, { role: 'AXLayoutArea', desc: 'Mixer', depth: 3 }), { timeout: 15_000 })
    }
    return area
  }

  /** Every channel strip, left to right: { name, h }. */
  async function strips() {
    const area = await mixer()
    const dump = await ax('ax.dump', { el: area.h, depth: 1, max: 400 })
    return (dump.children ?? []).filter(c => c.role === 'AXLayoutItem').map(c => ({ name: c.desc ?? '', h: c.h }))
  }

  /**
   * The exported names of the tracks that are only the SUM of other tracks: a
   * track stack's own strip (an aux fed by the bus its tracks play into). Its
   * export is its tracks added up, so counting it beside them counts them twice.
   */
  async function sumTracks() {
    const area = await mixer()
    const dump = await ax('ax.dump', { el: area.h, depth: 2, max: 400 })
    const rows = (dump.children ?? []).filter(c => c.role === 'AXLayoutItem').map(c => {
      const buttons = (c.children ?? []).filter(k => k.role === 'AXButton')
      const slot = kind => buttons.find(b => new RegExp(`^${kind} slot`).test(b.help ?? ''))?.desc ?? null
      return { name: c.desc ?? '', input: slot('Input'), output: slot('Output'), records: buttons.some(b => b.desc === 'record') }
    })
    return exportNames(rows.map(r => r.name)).filter((_, i) => {
      const r = rows[i]
      // An audio track also has an input slot; it has a record button, an aux does not.
      return !!r.input && !r.records && rows.some((o, j) => j !== i && o.output === r.input)
    })
  }

  /** Every strip's mute and solo switches, read fresh from the mixer: [{ index, name, mute, solo }]. */
  async function switches() {
    const area = await mixer()
    const dump = await ax('ax.dump', { el: area.h, depth: 2, max: 400 })
    return (dump.children ?? []).filter(c => c.role === 'AXLayoutItem').map((c, index) => {
      const button = desc => (c.children ?? []).find(k => k.role === 'AXButton' && k.desc === desc)
      return { index, name: c.desc ?? '', mute: button('mute'), solo: button('solo') }
    })
  }

  /** The strips that are muted or soloed: either changes what a bounce contains. As { index, name }. */
  async function silenced() {
    const all = await switches()
    const pick = key => all.filter(s => s[key]?.value === 'on').map(s => ({ index: s.index, name: s.name }))
    return { muted: pick('mute'), soloed: pick('solo') }
  }

  /**
   * Mutes or unmutes strips (in the copy) by their place in the mixer, and
   * confirms each took. A switch's value does not follow the press on the
   * handle that was pressed, so the mixer is read again to see it.
   */
  async function setMuted(strips, on) {
    for (const want of strips) {
      const now = (await switches())[want.index]
      if (!now?.mute || (now.mute.value === 'on') === on) continue
      await press(now.mute.h)
      await sleep(700)
      const after = (await switches())[want.index]
      if ((after?.mute?.value === 'on') !== on) throw new LogicProblem(`${want.name} could not be ${on ? 'muted' : 'unmuted'}`)
    }
  }

  async function save() {
    await menu(['File', 'Save'])
    await whileBusy('saving', 120_000)
  }

  async function close() {
    await closePluginWindows().catch(() => null)
    // Anything still in the way (a dialog left by a failed step) is dismissed: this is the copy.
    for (const w of await windows()) {
      if (w.id === 'save-panel' || w.id === 'open-panel' || /^Bounce /.test(w.title)) {
        const cancel = await one(w.h, { role: 'AXButton', title: 'Cancel', depth: 2 })
        if (cancel) await press(cancel.h)
        await sleep(600)
      }
    }
    if (await mainWindow()) {
      await menu(['File', 'Close Project'])
      await sleep(1500)
      const a = await alert()
      if (a) {
        const no = a.buttons.find(b => /^(don.t save|discard|delete)/i.test(b.title))
        if (no) await press(no.h)
      }
      await until('the copy closed', async () => !(await mainWindow()), { timeout: 60_000 }).catch(err => log(err.message))
    }
    // Put back what the owner had open.
    for (const path of state.reopen) {
      await ax('app.open', { path }).catch(err => log(`could not reopen ${basename(path)}: ${err.message}`))
      await sleep(3000)
    }
    state.reopen = []
  }

  // ── Save and export dialogs ───────────────────────────────────────────────
  // Logic's save dialogs take no typed path. So in the folder the dialog opens
  // in, a new folder is made with the dialog's own New Folder button, named
  // for the job and ending ".nosync" (iCloud Drive leaves such a folder
  // alone), and the files are moved out of it afterwards. Logic then opens
  // the next dialog of that kind in the same folder.

  async function intoOurFolder(panel) {
    const where = async () => (await one(panel.h, { role: 'AXPopUpButton', id: 'where popup', depth: 3 }))?.value ?? ''
    const current = await where()
    // The bounce dialog and the export dialog each remember their own folder.
    if (state.outDirs.some(d => basename(d) === current)) return current
    const name = `mixBASE Intern ${tag}-${state.outDirs.length + 1}.nosync`
    // Press again if nothing came.
    let sheet = null
    for (let tries = 0; tries < 4 && !sheet; tries++) {
      await press((await one(panel.h, { role: 'AXButton', id: 'NewFolderButton', depth: 3 })).h)
      sheet = await until('the New Folder sheet', () => one(panel.h, { role: 'AXSheet', depth: 2 }), { timeout: 4000 }).catch(() => null)
    }
    if (!sheet) throw new LogicProblem('Logic\'s save dialog would not make a folder for the job')
    await ax('ax.set', { el: (await one(sheet.h, { role: 'AXTextField', depth: 2 })).h, attr: 'AXValue', value: name })
    await press((await one(sheet.h, { role: 'AXButton', title: 'Create', depth: 2 })).h)
    await until('the new folder', async () => (await where()) === name, { timeout: 15_000 })
    state.outDirs.push(name)
    // Its full path, written down at once so the folder is cleaned up even if the job stops right here.
    const made = (await ax('logic.savedir').catch(() => null))?.path
    if (made && basename(made) === name) { state.outDirs[state.outDirs.length - 1] = made; await onFolder(made) }
    return name
  }

  /**
   * Presses a dialog's default button and makes sure the dialog went: a press
   * right after the dialog changed (a folder was just made in it) can be
   * ignored, so it is pressed again until the dialog is gone.
   */
  async function confirm(panelId) {
    for (let tries = 0; tries < 4; tries++) {
      const panel = (await windows()).find(w => w.id === panelId)
      if (!panel) return
      await sleep(SETTLE_MS)
      const ok = await one(panel.h, { role: 'AXButton', id: 'OKButton', depth: 3 })
      if (ok) await press(ok.h)
      const gone = await until('the dialog to close', async () => !(await windows().catch(() => [{ id: panelId }])).some(w => w.id === panelId), { timeout: 6000 }).catch(() => false)
      if (gone) return
    }
    throw new LogicProblem('Logic\'s dialog would not accept the folder it was given')
  }

  /** Where Logic last wrote: the folder its save dialog was in. */
  async function lastFolder(expectName) {
    // Logic's note of the folder can lag the save by a moment.
    let dir = null
    for (let i = 0; i < 10 && (!dir || basename(dir) !== expectName); i++) {
      if (i) await sleep(1000)
      dir = (await ax('logic.savedir')).path
    }
    if (!dir || basename(dir) !== expectName) throw new LogicProblem('Logic wrote the file somewhere unexpected; nothing was used')
    const i = state.outDirs.findIndex(d => basename(d) === expectName)
    if (i >= 0 && state.outDirs[i] !== dir) { state.outDirs[i] = dir; await onFolder(dir) }
    return dir
  }

  async function setPopup(root, current, want) {
    // The value exactly: "On" must not find "One File per Track".
    const popup = (await find(root, { role: 'AXPopUpButton', valueHas: current, depth: 4, limit: 12 })).find(p => p.value === current && p.enabled !== false)
    if (!popup) return false
    await press(popup.h)
    await sleep(400)
    const items = await find(popup.h, { role: 'AXMenuItem', limit: 30 })
    if (!items.length) return false
    const pick = items.find(i => i.title.toLowerCase().startsWith(want.toLowerCase()))
    await press((pick ?? items.find(i => i.title === current) ?? items[0]).h)
    await sleep(300)
    return !!pick
  }

  async function setCheckbox(root, title, on) {
    const box = await one(root, { role: 'AXCheckBox', title, depth: 4 })
    if (box && (box.value === 1) !== on) await press(box.h)
  }

  /** Bounce the project to `file` (a .wav path), with the owner's own bounce settings. */
  async function bounce(file) {
    await closePluginWindows()
    await menu(['File', 'Bounce', 'Project or Section...'])
    const dialog = await until('the Bounce dialog', async () => (await windows()).find(w => /^Bounce /.test(w.title) && w.id !== 'save-panel'), { timeout: 20_000 })
    await sleep(SETTLE_MS)
    // One uncompressed WAVE file; everything else (bit depth, normalize, range) stays as the owner bounces.
    for (const row of await find(dialog.h, { role: 'AXCheckBox', id: 'enable', depth: 5, limit: 6 })) {
      const want = row.desc === 'Uncompressed' ? 1 : 0
      if (row.value !== want) await press(row.h)
    }
    for (const other of ['AIFF', 'CAF']) await setPopup(dialog.h, other, 'WAVE')
    await setCheckbox(dialog.h, 'Add to Project', false)
    await setCheckbox(dialog.h, 'Add to Apple Music Library', false)
    await press((await one(dialog.h, { role: 'AXButton', title: 'OK', depth: 2 })).h)

    const panel = await until('the save dialog', async () => (await windows()).find(w => w.id === 'save-panel'), { timeout: 20_000 })
    await sleep(SETTLE_MS)
    const outName = await intoOurFolder(panel)
    const name = `bounce-${Date.now()}`
    await ax('ax.set', { el: (await one(panel.h, { role: 'AXTextField', id: 'saveAsNameTextField', depth: 3 })).h, attr: 'AXValue', value: name })
    await confirm('save-panel')
    // A real-time bounce (some plug-ins force one) takes the length of the song.
    await whileBusy('bouncing', 30 * 60_000)
    const dir = await lastFolder(outName)
    const made = join(dir, `${name}.wav`)
    await until('the bounce file', async () => !!(await stat(made).catch(() => null)), { timeout: 30_000 })
    await rename(made, file).catch(async () => { const { copyFile } = await import('node:fs/promises'); await copyFile(made, file); await rm(made, { force: true }) })
    return file
  }

  /**
   * Export every track to `folder` as "<track>.wav", as they sound in the mix:
   * effects on, volume and pan automation included, not normalized, 32-bit
   * float so a hot track is not clipped. Otherwise the tracks do not add up
   * to the mix.
   */
  async function exportTracks(folder) {
    await closePluginWindows()
    await menu(['File', 'Export', 'All Tracks as Audio Files...'])
    const panel = await until('the export dialog', async () => (await windows()).find(w => w.id === 'open-panel'), { timeout: 20_000 })
    await sleep(SETTLE_MS)
    for (const other of ['AIFF', 'CAF']) await setPopup(panel.h, other, 'WAVE')
    for (const other of ['8-bit', '16-bit', '24-bit']) await setPopup(panel.h, other, '32-bit float')
    for (const other of ['Overload Protection Only', 'On']) await setPopup(panel.h, other, 'Off')
    for (const other of ['Export Cycle Range Only', 'Extend File Length to Project End']) await setPopup(panel.h, other, 'Trim Silence at File End')
    await setCheckbox(panel.h, 'Bypass Effect Plug-ins', false)
    await setCheckbox(panel.h, 'Include Volume/Pan Automation', true)
    await setCheckbox(panel.h, 'Add resulting files to Project Browser', false)
    const outName = await intoOurFolder(panel)
    await confirm('open-panel')
    await whileBusy('exporting the tracks', 90 * 60_000)
    const dir = await lastFolder(outName)
    await mkdir(folder, { recursive: true })
    const files = (await readdir(dir)).filter(f => /\.(wav|wave|aif|aiff|caf)$/i.test(f) && !/^bounce-\d+\./.test(f))
    if (!files.length) throw new LogicProblem('Logic exported no tracks')
    for (const f of files) await rename(join(dir, f), join(folder, `${trackOfFile(f, state.project)}${extname(f)}`))
    return files.length
  }

  /** The folders made beside the owner's files during the job, to be removed when it ends. */
  async function cleanup() {
    for (const dir of state.outDirs) {
      if (!dir.includes('/') || !basename(dir).startsWith('mixBASE Intern ') || !dir.endsWith('.nosync')) continue
      await rm(dir, { recursive: true, force: true }).catch(err => log(`could not remove ${basename(dir)}: ${err.message}`))
    }
    state.outDirs = []
  }

  // ── Plug-ins ──────────────────────────────────────────────────────────────

  const insertsOf = async strip => {
    const kids = (await ax('ax.dump', { el: strip.h, depth: 2, max: 80 })).children ?? []
    return {
      empty: kids.filter(k => k.role === 'AXButton' && k.desc === 'audio plug-in').sort((a, b) => a.frame[1] - b.frame[1]),
      used: kids.filter(k => k.role === 'AXGroup' && k.children?.some(c => c.desc === 'open')).sort((a, b) => a.frame[1] - b.frame[1]),
    }
  }

  async function pluginWindow(stripName) {
    const win = await until('the plug-in window', async () => {
      for (const w of await windows()) if (w.title === stripName && await isPlugin(w)) return w
      return null
    }, { timeout: 20_000 })
    await sleep(SETTLE_MS)
    return win
  }

  async function setView(win, view) {
    const button = await one(win.h, { role: 'AXMenuButton', desc: 'view', depth: 1 })
    await press(button.h)
    await sleep(400)
    const item = (await find(button.h, { role: 'AXMenuItem', title: view, limit: 1 }))[0] ?? (await find('app', { role: 'AXMenuItem', title: view, depth: 5, limit: 1 }))[0]
    if (item) await press(item.h)
    await sleep(700)
  }

  /** One row of a plug-in's Controls view, found by its label ("Gain:"). */
  async function controlRow(win, label) {
    const text = (await find(win.h, { role: 'AXStaticText', valueHas: `${label}:`, depth: 8, limit: 12 })).find(t => t.value === `${label}:`)
    if (!text) throw new LogicProblem(`The plug-in has no "${label}" control`)
    const cell = await ax('ax.get', { el: text.h, attr: 'AXParent' })
    return (await ax('ax.dump', { el: cell.el, depth: 2 })).children ?? []
  }

  /** Sets a numeric control to `target` and returns what the plug-in then shows. */
  async function setNumber(win, label, target) {
    const row = await controlRow(win, label)
    const slider = row.find(c => c.role === 'AXSlider'), readout = row.find(c => c.role === 'AXGroup')
    if (!slider || !readout) throw new LogicProblem(`"${label}" is not a control that can be set`)
    // The readout follows the slider a moment later.
    const shown = async () => { await sleep(80); return readNumber(await ax('ax.get', { el: readout.h, attr: 'AXValue' })) }
    const range = await ax('ax.attrs', { el: slider.h })
    let lo = Number(range.attributes.AXMinValue ?? 0), hi = Number(range.attributes.AXMaxValue ?? 1000)
    // The slider's own scale is not the unit shown (and is not linear): close in on the shown value.
    let best = null
    for (let i = 0; i < 24 && hi - lo > 0; i++) {
      const mid = Math.round((lo + hi) / 2)
      await ax('ax.set', { el: slider.h, attr: 'AXValue', value: mid })
      const v = await shown()
      if (v == null) throw new LogicProblem(`"${label}" could not be read back`)
      if (best == null || Math.abs(v - target) < Math.abs(best.v - target)) best = { mid, v }
      if (v === target) break
      if (v < target) lo = mid + 1; else hi = mid - 1
    }
    await ax('ax.set', { el: slider.h, attr: 'AXValue', value: best.mid })
    // One slider step at a time for the last tenth.
    let at = best.mid, v = await shown()
    for (let i = 0; i < 8 && v != null && v !== target; i++) {
      const next = at + (v < target ? 1 : -1)
      await ax('ax.set', { el: slider.h, attr: 'AXValue', value: next })
      const nv = await shown()
      if (nv == null || Math.abs(nv - target) >= Math.abs(v - target)) { await ax('ax.set', { el: slider.h, attr: 'AXValue', value: at }); break }
      at = next; v = nv
    }
    return shown()
  }

  async function setSwitch(win, label, on) {
    const row = await controlRow(win, label)
    const box = row.find(c => c.role === 'AXCheckBox')
    if (box && (box.value === 1) !== on) await press(box.h)
  }

  const KINDS = {
    level: { name: 'Gain', menu: ['Utility', 'Gain'] },
    eq: { name: 'Channel EQ', menu: ['EQ', 'Channel EQ'] },
  }

  /** Opens the intern's own plug-in for a move on a strip, inserting it after everything else the first time. */
  async function ourPlugin(strip, kind) {
    const key = `${strip.index}|${kind}`
    const spec = KINDS[kind]
    let { empty, used } = await insertsOf(strip)
    if (state.ours.has(key)) {
      const mine = used.filter(u => u.desc.trim() === spec.name).pop()
      if (!mine) throw new LogicProblem(`The ${spec.name} added on ${strip.name} is gone`)
      await press(mine.children.find(c => c.desc === 'open').h)
      return pluginWindow(strip.name)
    }
    if (!empty.length) throw new LogicProblem(`${strip.name} has no free plug-in slot`)
    await press(empty[0].h)
    const menu = await until('the plug-in menu', async () => (await find('app', { role: 'AXMenu', depth: 4, limit: 1 }))[0], { timeout: 10_000 })
    let at = menu.h
    for (const title of spec.menu) {
      const item = (await find(at, { role: 'AXMenuItem', title, depth: 2, limit: 1 }))[0]
      if (!item) throw new LogicProblem(`Logic's plug-in menu has no "${spec.menu.join(' > ')}"`)
      at = item.h
    }
    // Stereo on a stereo strip, Mono on a mono one: whichever the strip offers first.
    const formats = await find(at, { role: 'AXMenuItem', depth: 2, limit: 6 })
    const format = formats.find(f => f.title === 'Stereo') ?? formats.find(f => f.title === 'Mono') ?? formats[0]
    if (!format) throw new LogicProblem(`${spec.name} cannot be added to ${strip.name}`)
    await press(format.h)
    state.ours.set(key, true)
    return pluginWindow(strip.name)
  }

  /**
   * Makes the planned moves (InternMove[] from intern-rules.ts): a level move
   * is a Gain plug-in, a bell is one band of a Channel EQ, each added as the
   * LAST plug-in on its strip so nothing of the owner's is touched and volume
   * automation cannot undo it. Called again with resized moves, it sets the
   * same plug-ins. Returns what each control then showed.
   */
  async function applyMoves(moves) {
    const all = await strips()
    const names = all.map(s => s.name)
    const done = []
    for (const move of moves) {
      const index = stripIndexFor(move.track, names)
      if (index < 0) throw new LogicProblem(`There is no channel strip named "${move.track}" in the mixer`)
      await closePluginWindows()
      // Handles go stale as the mixer redraws: look the strip up again each time.
      const strip = { ...(await strips())[index], index }
      const win = await ourPlugin(strip, move.kind)
      await setView(win, 'Controls')
      let shown
      if (move.kind === 'level') {
        shown = { gain: await setNumber(win, 'Gain', move.gainDb) }
      } else {
        await setSwitch(win, 'Gain-Q Coupling', false)
        shown = {
          hz: await setNumber(win, 'Peak 1 Frequency', move.hz),
          q: await setNumber(win, 'Peak 1 Q-Factor', move.q),
          gain: await setNumber(win, 'Peak 1 Gain', move.gainDb),
        }
      }
      if (shown.gain == null || Math.abs(shown.gain - move.gainDb) > 0.15) throw new LogicProblem(`${strip.name}: the ${KINDS[move.kind].name} would not take ${move.gainDb} dB (it shows ${shown.gain})`)
      // Leave the plug-in as the owner would find any other: in its editor view.
      await setView(win, 'Editor')
      await closePluginWindows()
      done.push({ track: strip.name, kind: move.kind, ...shown })
      log(`set ${KINDS[move.kind].name} on ${strip.name}: ${JSON.stringify(shown)}`)
    }
    return done
  }

  return { open, close, save, bounce, exportTracks, applyMoves, strips, sumTracks, silenced, setMuted, cleanup, state }
}
