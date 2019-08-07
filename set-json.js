#!/usr/bin/env node

// Run as: ./set-json MY.json abc=123 'def.ghi="string"'
const process = require('process');
const fs = require('fs');

// point this at ~/.ag-cosmos-chain/config/genesis.json
const [file, ...substs] = process.argv.slice(2);

let config;
try {
  let configString;
  if (file === '-') {
    configString = fs.readFileSync(0, 'utf-8');
  } else {
    configString = fs.readFileSync(process.argv[2], 'utf-8');
  }
  config = JSON.parse(configString);
} catch (e) {
  if (e.code === 'ENOENT') {
    config = {};
  } else {
    throw e;
  }
}

for (const pathEquals of substs) {
  const match = pathEquals.match(/^([^=]+)=(.*)$/);
  if (!match) {
    throw Error(`not a path=value argument ${pathEquals}`);
  }
  const path = match[1];
  const jsonVal = match[2];
  const val = JSON.parse(jsonVal);
  let obj = config;
  const ps = path.split('.');
  for (let i = 0; i < ps.length - 1; i += 1) {
    const p = ps[i];
    if (!(p in obj)) {
      obj[p] = {};
    }
    obj = obj[p];
  }

  obj[ps[ps.length - 1]] = val;
}

const outString = `${JSON.stringify(config, undefined, 2)}\n`;
if (file === '-') {
  process.stdout.write(outString);
} else {
  const tmpFile = `${file}.${process.pid}`;
  try {
    fs.writeFileSync(tmpFile, outString);
    fs.renameSync(tmpFile, file);
  } catch (e) {
    fs.unlinkSync(tmpFile);
  }
}
