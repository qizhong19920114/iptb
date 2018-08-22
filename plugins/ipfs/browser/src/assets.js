const fs = require('fs')

if (process.env.NODE_ENV === 'production') {
  module.exports.ipfsJS = () => require('ipfs/dist/index.min.js')
  module.exports.postmsgJS = () => require('../dist/postmsg.bundle.js')
  module.exports.indexHTML = () => require('../dist/index.html')
} else {
  module.exports.ipfsJS = () => fs.createReadStream('../node_modules/ipfs/dist/index.js')
  module.exports.postmsgJS = () => fs.createReadStream('../dist/postmsg.bundle.js')
  module.exports.indexHTML = () => fs.createReadStream('../dist/index.html')
}
