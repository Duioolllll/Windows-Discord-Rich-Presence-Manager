const fs = require('node:fs');
fs.cpSync('src/ui', 'dist-js/ui', { recursive: true });
