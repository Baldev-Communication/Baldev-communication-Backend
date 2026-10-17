const { parentPort, workerData } = require('node:worker_threads');
require('./spreadsheet').parse(workerData.buffer, workerData.name)
  .then(sheets => parentPort.postMessage({ sheets }))
  .catch(error => parentPort.postMessage({ error: error.message || 'The spreadsheet could not be read.' }));
