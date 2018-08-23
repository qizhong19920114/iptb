const fs = require('fs')

if (process.env.NODE_ENV === 'production') {
  module.exports.ipfsJS = () => require('raw-loader!ipfs/dist/index.min.js')
  module.exports.vendorJS = () => require('raw-loader!../dist/vendor.js')
  module.exports.indexHTML = () => require('raw-loader!./index.html')
} else {
  module.exports.ipfsJS = () => fs.createReadStream('../node_modules/ipfs/dist/index.js')
  module.exports.vendorJS = () => fs.createReadStream('../dist/vendor.js')
  module.exports.indexHTML = () => fs.createReadStream('./index.html')
}
