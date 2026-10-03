// Cassette Studio scene presets + the scene prompt.
//
// Client-safe (no server imports): the screen lists the labels, the render
// route turns an id into the FLUX Fill prompt.
//
// Every scene is a SURFACE the cassette can stand on, photographed at eye
// level from the cassette's own height. That matters more than the setting:
// the cassette photo is a straight-on, eye-level shot, and a scene seen from
// above (a desk shot from a standing height) can never line up with it — the
// mismatch in perspective is the first thing that gives a composite away.
// So every preset names a ledge/counter/rail, and the template pins the camera.
//
// Language follows src/lib/artwork-models.ts: what a photographer would write
// in a caption — places, materials, light — never "8k / hyper-real /
// masterpiece", which pull image models toward their CGI look.

export type CassetteScene = { id: string; label: string; setting: string }

export const CASSETTE_SCENES: CassetteScene[] = [
  { id: 'city-ledge', label: 'City ledge, blue hour', setting: 'a dark stone balcony ledge, office towers and a city street at blue hour behind it, a few lit windows, traffic lights glowing far below' },
  { id: 'rooftop', label: 'Rooftop at dusk', setting: 'a weathered concrete rooftop parapet, a city skyline at dusk behind it, pink and orange clouds low over the buildings' },
  { id: 'diner', label: 'Diner counter, neon', setting: 'a worn formica diner counter beside a rain-streaked window, red and blue neon signs glowing outside at night' },
  { id: 'dashboard', label: 'Car dashboard, night', setting: 'the dashboard of an old car at night, a wet windshield, streetlights and tail lights blurred through the glass' },
  { id: 'wet-street', label: 'Wet street after rain', setting: 'wet asphalt on an empty city street after rain at night, puddles reflecting streetlights and shop signs' },
  { id: 'pier', label: 'Pier at golden hour', setting: 'a weathered wooden pier railing, a calm ocean and a low sun at golden hour behind it' },
  { id: 'desert', label: 'Desert highway', setting: 'a rusty steel guardrail on an empty desert highway, flat desert and distant mountains at sunset' },
  { id: 'subway', label: 'Subway platform', setting: 'a tiled subway platform bench under fluorescent light, an empty platform and tunnel behind it' },
  { id: 'record-store', label: 'Record store counter', setting: 'a scuffed wooden record-store counter, crates of vinyl records and warm lamp light behind it' },
  { id: 'studio', label: 'Home studio desk', setting: 'a home studio desk, a mixing console and monitor speakers behind it, warm practical lamp light, late evening' },
  { id: 'rainy-window', label: 'Rainy windowsill', setting: 'a painted wooden windowsill, rain running down the window, a grey city outside' },
  { id: 'snow', label: 'Snowy wall, winter', setting: 'a snow-covered stone wall, a quiet winter street with warm streetlights behind it at dusk' },
  { id: 'garage', label: 'Parking garage', setting: 'a concrete ledge in an empty parking garage at night, orange sodium lights, a ramp curving away behind it' },
  { id: 'boardwalk', label: 'Beach boardwalk', setting: 'a sun-bleached wooden boardwalk rail, a beach and slow ocean waves in soft afternoon light' },
  { id: 'motel', label: 'Motel nightstand', setting: 'a motel room nightstand, a bedside lamp casting warm light, drawn curtains, late at night' },
  { id: 'forest', label: 'Forest, morning fog', setting: 'a mossy fallen log in a pine forest, morning fog drifting between the trees' },
  { id: 'laundromat', label: 'Laundromat, late night', setting: 'a laundromat folding counter, a row of washing machines behind it, flat fluorescent light, late at night' },
  { id: 'train', label: 'Train window', setting: 'the window ledge of a moving train, countryside passing outside at golden hour' },
]

const SCENE_IDS = new Set(CASSETTE_SCENES.map(s => s.id))
export function isSceneId(v: unknown): v is string {
  return typeof v === 'string' && SCENE_IDS.has(v)
}

/** Longest custom setting accepted (characters). */
export const MAX_CUSTOM_SETTING = 300

/**
 * The FLUX Fill prompt. It describes the WHOLE photograph — cassette
 * included — because the model is painting around a cassette it can see; a
 * prompt that only described the background would leave it guessing what the
 * object is and how it should be lit and grounded.
 */
export function scenePrompt(setting: string): string {
  const s = setting.trim().replace(/\s+/g, ' ').slice(0, MAX_CUSTOM_SETTING).replace(/[.\s]+$/, '')
  return [
    `A real photograph of a clear plastic audio cassette tape standing upright on ${s}.`,
    'Eye-level shot taken from the height of the cassette, the cassette in sharp focus,',
    'the surface it stands on receding away from the camera, the background softly out of focus.',
    'The light in the scene falls on the cassette and it casts a soft shadow where it touches the surface.',
    'Shot on a full-frame camera with a 50mm lens at f/2, natural colour, fine film grain, deserted, quiet.',
  ].join(' ')
}
