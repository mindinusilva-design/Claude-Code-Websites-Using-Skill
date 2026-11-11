// The standalone page has no file system; storage lives in src/browser/store.js.
const unavailable = (name) => () => { throw new Error(`fs.${name} is not available in the standalone page`); };
export const existsSync = () => false;
export const mkdirSync = () => {};
export const readFileSync = unavailable('readFileSync');
export const writeFileSync = unavailable('writeFileSync');
export const renameSync = unavailable('renameSync');
export const rmSync = unavailable('rmSync');
export const readdirSync = () => [];
export default { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync };
