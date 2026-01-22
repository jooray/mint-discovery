const path = require('path');

module.exports = {
  entry: './index.js',
  output: {
    filename: 'mint-discovery.bundle.js',
    path: path.resolve(__dirname, 'dist'),
    library: {
      name: 'MintDiscovery',
      type: 'umd',
      export: 'MintDiscovery'
    },
    globalObject: 'this'
  },
  mode: 'production'
};
