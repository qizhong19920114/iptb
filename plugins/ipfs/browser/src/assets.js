const fs = require('fs')

if (process.env.NODE_ENV === 'production') {
  module.exports.postmsgJS = () => require('../dist/postmsg.bundle.js')
  module.exports.indexHTML = () => require('../dist/index.html')
} else {
  module.exports.postmsgJS = () => fs.createReadStream('../dist/postmsg.bundle.js')
  module.exports.indexHTML = () => fs.createReadStream('../dist/index.html')
}
