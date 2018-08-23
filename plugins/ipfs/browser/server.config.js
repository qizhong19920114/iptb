const path = require('path')

module.exports = {
  target: 'node',
  entry: './src/server.js',
  mode: 'production',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'server.js',
  }
}

