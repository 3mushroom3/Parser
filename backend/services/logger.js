function ts() {
  return new Date().toISOString();
}

module.exports = {
  info(tag, msg, ...rest) {
    console.log(`[${ts()}][INFO]${tag ? `[${tag}]` : ''}`, msg, ...rest);
  },
  warn(tag, msg, ...rest) {
    console.warn(`[${ts()}][WARN]${tag ? `[${tag}]` : ''}`, msg, ...rest);
  },
  error(tag, msg, ...rest) {
    console.error(`[${ts()}][ERROR]${tag ? `[${tag}]` : ''}`, msg, ...rest);
  },
};
