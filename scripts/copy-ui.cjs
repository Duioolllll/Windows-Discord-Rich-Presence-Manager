const fs = require('node:fs');
fs.cpSync('src/ui', 'dist-js/ui', { recursive: true });
fs.cpSync('src/assets', 'dist-js/assets', { recursive: true });
