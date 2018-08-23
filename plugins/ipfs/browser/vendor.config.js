const path = require('path')

module.exports = {
  target: 'web',
  entry: './src/vendor.js',
  mode: 'production',
  output: {
    libraryTarget: 'umd',
    path: path.resolve(__dirname, 'dist'),
    filename: 'vendor.js',
  }
}
