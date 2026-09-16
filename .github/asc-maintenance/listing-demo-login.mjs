// Exports the App Review demo login to the job environment. Nothing sensitive
// is printed: the password is masked first, then both values go to
// $GITHUB_ENV as MIXBASE_EMAIL / MIXBASE_PASSWORD for the screenshot tour.

import { appendFileSync } from "node:fs";
import { demoLogin, findApp } from "./listing-asc.mjs";

const app = await findApp();
const { email, password, version } = await demoLogin(app);
console.log(`::add-mask::${password}`);
console.log(`demo account ${email} (from the ${version} review detail, ${password.length}-char password)`);
if (!process.env.GITHUB_ENV) {
  console.error("GITHUB_ENV is not set; refusing to print credentials");
  process.exit(1);
}
appendFileSync(process.env.GITHUB_ENV, `MIXBASE_EMAIL=${email}\nMIXBASE_PASSWORD=${password}\n`);
