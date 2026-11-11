export const sep = '/';
export const join = (...parts) => parts.filter(Boolean).join('/').replace(/\/+/g, '/');
export const resolve = join;
export const extname = (p) => (/\.[^./]+$/.exec(p) ?? [''])[0];
export default { sep, join, resolve, extname };
