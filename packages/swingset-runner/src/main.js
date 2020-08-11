import path from 'path';
import fs from 'fs';
import process from 'process';
import repl from 'repl';
import util from 'util';

import { makeStatLogger } from '@agoric/stat-logger';
import {
  buildVatController,
  loadSwingsetConfigFile,
  loadBasedir,
} from '@agoric/swingset-vat';
import {
  initSwingStore as initSimpleSwingStore,
  openSwingStore as openSimpleSwingStore,
} from '@agoric/swing-store-simple';
import {
  initSwingStore as initLMDBSwingStore,
  openSwingStore as openLMDBSwingStore,
} from '@agoric/swing-store-lmdb';

import { dumpStore } from './dumpstore';
import { auditRefCounts } from './auditstore';
import { printStats, printBenchmarkStats } from './printStats';

const log = console.log;

function p(item) {
  return util.inspect(item, false, null, true);
}

function readClock() {
  return process.hrtime.bigint();
}

function usage() {
  log(`
Command line:
  runner [FLAGS...] CMD [{BASEDIR|--} [ARGS...]]

FLAGS may be:
  --init           - discard any existing saved state at startup.
  --lmdb           - runs using LMDB as the data store (default)
  --filedb         - runs using the simple file-based data store
  --memdb          - runs using the non-persistent in-memory data store
  --blockmode      - run in block mode (checkpoint every BLOCKSIZE blocks)
  --blocksize N    - set BLOCKSIZE to N cranks (default 200)
  --logtimes       - log block execution time stats while running
  --logmem         - log memory usage stats after each block
  --logdisk        - log disk space usage stats after each block
  --logstats       - log kernel stats after each block
  --logall         - log kernel stats, block times, memory use, and disk space
  --logtag STR     - tag for stats log file (default "runner")
  --forcegc        - run garbage collector after each block
  --batchsize N    - set BATCHSIZE to N cranks (default 200)
  --verbose        - output verbose debugging messages as it runs
  --audit          - audit kernel promise reference counts after each crank
  --dump           - dump a kernel state store snapshot after each crank
  --dumpdir DIR    - place kernel state dumps in directory DIR (default ".")
  --dumptag STR    - prefix kernel state dump filenames with STR (default "t")
  --raw            - perform kernel state dumps in raw mode
  --stats          - print performance stats at the end of a run
  --benchmark N    - perform an N round benchmark after the initial run
  --indirect       - launch swingset from a vat instead of launching directly
  --globalmetering - install metering on global objects
  --meter          - run metered vats (implies --globalmetering and --indirect)
  --config FILE    - read swingset config from FILE instead of inferring it

CMD is one of:
  help   - print this helpful usage information
  run    - launches or resumes the configured vats, which run to completion.
  batch  - launch or resume, then run BATCHSIZE cranks or until completion
  step   - steps the configured swingset one crank.
  shell  - starts a simple CLI allowing the swingset to be run or stepped or
           interrogated interactively.

BASEDIR is the base directory for locating the swingset's vat definitions.
  If BASEDIR is omitted or '--' it defaults to the current working directory.

Any remaining args are passed to the swingset's bootstrap vat.
`);
}

function fail(message, printUsage) {
  log(message);
  if (printUsage) {
    usage();
  }
  process.exit(1);
}

function generateIndirectConfig(baseConfig) {
  const config = {
    bootstrap: 'launcher',
    bundles: {},
    vats: {
      launcher: {
        sourcePath: path.resolve(__dirname, 'vat-launcher.js'),
        parameters: {
          config: {
            bootstrap: baseConfig.bootstrap,
            vats: {},
          },
        },
      },
    },
  };
  if (baseConfig.vats) {
    for (const vatName of Object.keys(baseConfig.vats)) {
      const baseVat = { ...baseConfig.vats[vatName] };
      let newBundleName = `bundle-${vatName}`;
      if (baseVat.sourcePath) {
        config.bundles[newBundleName] = { sourcePath: baseVat.sourcePath };
        delete baseVat.sourcePath;
      } else if (baseVat.bundlePath) {
        config.bundles[newBundleName] = { bundlePath: baseVat.bundlePath };
        delete baseVat.bundlePath;
      } else if (baseVat.bundle) {
        config.bundles[newBundleName] = { bundle: baseVat.bundle };
        delete baseVat.bundle;
      } else if (baseVat.bundleName) {
        newBundleName = baseVat.bundleName;
        config.bundles[newBundleName] = baseConfig.bundles[baseVat.bundleName];
      } else {
        fail(`this can't happen`);
      }
      baseVat.bundleName = newBundleName;
      config.vats.launcher.parameters.config.vats[vatName] = baseVat;
    }
  }
  if (baseConfig.bundles) {
    for (const bundleName of Object.keys(baseConfig.bundles)) {
      config.bundles[bundleName] = baseConfig.bundles[bundleName];
    }
  }
  return config;
}

/* eslint-disable no-use-before-define */

/**
 * Command line utility to run a swingset for development and testing purposes.
 */
export async function main() {
  const argv = process.argv.splice(2);

  let forceReset = false;
  let dbMode = '--lmdb';
  let blockSize = 200;
  let batchSize = 200;
  let blockMode = false;
  let logTimes = false;
  let logMem = false;
  let logDisk = false;
  let logStats = false;
  let logTag = 'runner';
  let forceGC = false;
  let verbose = false;
  let doDumps = false;
  let doAudits = false;
  let dumpDir = '.';
  let dumpTag = 't';
  let rawMode = false;
  let shouldPrintStats = false;
  let globalMeteringActive = false;
  let meterVats = false;
  let launchIndirectly = false;
  let benchmarkRounds = 0;
  let configPath = null;

  while (argv[0] && argv[0].startsWith('-')) {
    const flag = argv.shift();
    switch (flag) {
      case '--init':
        forceReset = true;
        break;
      case '--logtimes':
        logTimes = true;
        break;
      case '--logmem':
        logMem = true;
        break;
      case '--logdisk':
        logDisk = true;
        break;
      case '--logstats':
        logStats = true;
        break;
      case '--logall':
        logTimes = true;
        logMem = true;
        logDisk = true;
        logStats = true;
        break;
      case '--logtag':
        logTag = argv.shift();
        break;
      case '--config':
        configPath = argv.shift();
        break;
      case '--forcegc':
        forceGC = true;
        break;
      case '--blockmode':
        blockMode = true;
        break;
      case '--blocksize':
        blockSize = Number(argv.shift());
        break;
      case '--batchsize':
        batchSize = Number(argv.shift());
        break;
      case '--benchmark':
        benchmarkRounds = Number(argv.shift());
        break;
      case '--dump':
        doDumps = true;
        break;
      case '--dumpdir':
        dumpDir = argv.shift();
        doDumps = true;
        break;
      case '--dumptag':
        dumpTag = argv.shift();
        doDumps = true;
        break;
      case '--raw':
        rawMode = true;
        doDumps = true;
        break;
      case '--stats':
        shouldPrintStats = true;
        break;
      case '--globalmetering':
        globalMeteringActive = true;
        break;
      case '--meter':
        meterVats = true;
        globalMeteringActive = true;
        launchIndirectly = true;
        break;
      case '--indirect':
        launchIndirectly = true;
        break;
      case '--audit':
        doAudits = true;
        break;
      case '--filedb':
      case '--memdb':
      case '--lmdb':
        dbMode = flag;
        break;
      case '-v':
      case '--verbose':
        verbose = true;
        break;
      default:
        fail(`invalid flag ${flag}`, true);
    }
  }

  const command = argv.shift();
  if (
    command !== 'run' &&
    command !== 'shell' &&
    command !== 'step' &&
    command !== 'batch' &&
    command !== 'help'
  ) {
    fail(`'${command}' is not a valid runner command`, true);
  }
  if (command === 'help') {
    usage();
    process.exit(0);
  }

  if (globalMeteringActive) {
    log('global metering is active');
  }

  if (forceGC) {
    if (!global.gc) {
      fail(
        'To use --forcegc you must start node with the --expose-gc command line option',
      );
    }
    if (!logMem) {
      log('Warning: --forcegc without --logmem may be a mistake');
    }
  }

  // Prettier demands that the conditional not be parenthesized.  Prettier is wrong.
  // eslint-disable-next-line prettier/prettier
  let basedir = (argv[0] === '--' || argv[0] === undefined) ? '.' : argv.shift();
  const bootstrapArgv = argv[0] === '--' ? argv.slice(1) : argv;

  let config;
  if (configPath) {
    config = loadSwingsetConfigFile(configPath);
    if (config === null) {
      fail(`config file ${configPath} not found`);
    }
    basedir = path.dirname(configPath);
  } else {
    config = loadBasedir(basedir);
  }
  if (launchIndirectly) {
    config = generateIndirectConfig(config);
  }

  let store;
  const kernelStateDBDir = path.join(basedir, 'swingset-kernel-state');
  switch (dbMode) {
    case '--filedb':
      if (forceReset) {
        store = initSimpleSwingStore(kernelStateDBDir);
      } else {
        store = openSimpleSwingStore(kernelStateDBDir);
      }
      break;
    case '--memdb':
      store = initSimpleSwingStore();
      break;
    case '--lmdb':
      if (forceReset) {
        store = initLMDBSwingStore(kernelStateDBDir);
      } else {
        store = openLMDBSwingStore(kernelStateDBDir);
      }
      break;
    default:
      fail(`invalid database mode ${dbMode}`, true);
  }
  if (config.bootstrap) {
    config.vats[config.bootstrap].parameters.metered = meterVats;
  }
  const runtimeOptions = {};
  if (store) {
    runtimeOptions.hostStorage = store.storage;
  }
  if (verbose) {
    runtimeOptions.verbose = true;
  }
  const controller = await buildVatController(
    config,
    bootstrapArgv,
    runtimeOptions,
  );
  let bootstrapResult = controller.bootstrapResult;

  let blockNumber = 0;
  let statLogger = null;
  if (logTimes || logMem || logDisk) {
    let headers = ['block', 'steps'];
    if (logTimes) {
      headers.push('btime');
    }
    if (logMem) {
      headers = headers.concat(['rss', 'heapTotal', 'heapUsed', 'external']);
    }
    if (logDisk) {
      headers.push('disk');
    }
    if (logStats) {
      const statNames = Object.keys(controller.getStats());
      headers = headers.concat(statNames);
    }
    statLogger = makeStatLogger(logTag, headers);
  }

  let crankNumber = 0;
  switch (command) {
    case 'run': {
      await commandRun(0, blockMode);
      break;
    }
    case 'batch': {
      await commandRun(batchSize, blockMode);
      break;
    }
    case 'step': {
      const steps = await controller.step();
      store.commit();
      store.close();
      log(`runner stepped ${steps} crank${steps === 1 ? '' : 's'}`);
      break;
    }
    case 'shell': {
      const cli = repl.start({
        prompt: 'runner> ',
        replMode: repl.REPL_MODE_STRICT,
      });
      cli.on('exit', () => {
        store.close();
      });
      cli.context.dump2 = () => controller.dump();
      cli.defineCommand('commit', {
        help: 'Commit current kernel state to persistent storage',
        action: () => {
          store.commit();
          log('committed');
          cli.displayPrompt();
        },
      });
      cli.defineCommand('dump', {
        help: 'Dump the kernel tables',
        action: () => {
          const d = controller.dump();
          log('Kernel Table:');
          log(p(d.kernelTable));
          log('Promises:');
          log(p(d.promises));
          log('Run Queue:');
          log(p(d.runQueue));
          cli.displayPrompt();
        },
      });
      cli.defineCommand('block', {
        help: 'Execute a block of <n> cranks, without commit',
        action: async requestedSteps => {
          const steps = await runBlock(requestedSteps, false);
          log(`executed ${steps} cranks in block`);
          cli.displayPrompt();
        },
      });
      cli.defineCommand('benchmark', {
        help: 'Run <n> rounds of the benchmark protocol',
        action: async rounds => {
          const [steps, deltaT] = await runBenchmark(rounds);
          log(`benchmark ${rounds} rounds, ${steps} cranks in ${deltaT} ns`);
          cli.displayPrompt();
        },
      });
      cli.defineCommand('run', {
        help: 'Crank until the run queue is empty, without commit',
        action: async () => {
          const [steps, deltaT] = await runBatch(0, false);
          log(`ran ${steps} cranks in ${deltaT} ns`);
          cli.displayPrompt();
        },
      });
      cli.defineCommand('step', {
        help: 'Step the swingset one crank, without commit',
        action: async () => {
          const steps = await controller.step();
          log(steps ? 'stepped one crank' : "didn't step, queue is empty");
          cli.displayPrompt();
        },
      });
      break;
    }
    default:
      fail(`invalid command ${command}`);
  }
  if (statLogger) {
    statLogger.close();
  }

  function getCrankNumber() {
    return Number(store.storage.get('crankNumber'));
  }

  function kernelStateDump() {
    const dumpPath = `${dumpDir}/${dumpTag}${crankNumber}`;
    dumpStore(store.storage, dumpPath, rawMode);
  }

  async function runBenchmark(rounds) {
    const cranksPre = getCrankNumber();
    const statsPre = controller.getStats();
    const args = { body: '[]', slots: [] };
    let totalSteps = 0;
    let totalDeltaT = BigInt(0);
    for (let i = 0; i < rounds; i += 1) {
      const roundResult = controller.queueToVatExport(
        launchIndirectly ? 'launcher' : 'bootstrap',
        'o+0',
        'runBenchmarkRound',
        args,
        'ignore',
      );
      // eslint-disable-next-line no-await-in-loop
      const [steps, deltaT] = await runBatch(0, true);
      const status = roundResult.status();
      if (status === 'pending') {
        log(`benchmark round ${i + 1} did not finish`);
      } else {
        const resolution = JSON.stringify(roundResult.resolution());
        log(`benchmark round ${i + 1} ${status}: ${resolution}`);
      }
      totalSteps += steps;
      totalDeltaT += deltaT;
    }
    const cranksPost = getCrankNumber();
    const statsPost = controller.getStats();
    printBenchmarkStats(statsPre, statsPost, cranksPost - cranksPre, rounds);
    return [totalSteps, totalDeltaT];
  }

  async function runBlock(requestedSteps, doCommit) {
    const blockStartTime = readClock();
    let actualSteps = 0;
    if (verbose) {
      log('==> running block');
    }
    while (requestedSteps > 0) {
      requestedSteps -= 1;
      // eslint-disable-next-line no-await-in-loop
      const stepped = await controller.step();
      if (stepped < 1) {
        break;
      }
      crankNumber += stepped;
      actualSteps += stepped;
      if (doDumps) {
        kernelStateDump();
      }
      if (doAudits) {
        auditRefCounts(store.storage);
      }
      if (verbose) {
        log(`===> end of crank ${crankNumber}`);
      }
    }
    if (doCommit) {
      store.commit();
    }
    const blockEndTime = readClock();
    if (forceGC) {
      global.gc();
    }
    if (statLogger) {
      blockNumber += 1;
      let data = [blockNumber, actualSteps];
      if (logTimes) {
        data.push(blockEndTime - blockStartTime);
      }
      if (logMem) {
        const mem = process.memoryUsage();
        data = data.concat([
          mem.rss,
          mem.heapTotal,
          mem.heapUsed,
          mem.external,
        ]);
      }
      if (logDisk) {
        const diskUsage = dbMode === '--lmdb' ? store.diskUsage() : 0;
        data.push(diskUsage);
      }
      if (logStats) {
        data = data.concat(Object.values(controller.getStats()));
      }
      statLogger.log(data);
    }
    return actualSteps;
  }

  async function runBatch(stepLimit, doCommit) {
    const startTime = readClock();
    let totalSteps = 0;
    let steps;
    const runAll = stepLimit === 0;
    do {
      // eslint-disable-next-line no-await-in-loop
      steps = await runBlock(blockSize, doCommit);
      totalSteps += steps;
      stepLimit -= steps;
    } while ((runAll || stepLimit > 0) && steps >= blockSize);
    return [totalSteps, readClock() - startTime];
  }

  async function commandRun(stepLimit, runInBlockMode) {
    if (doDumps) {
      kernelStateDump();
    }
    if (doAudits) {
      auditRefCounts(store.storage);
    }

    let [totalSteps, deltaT] = await runBatch(stepLimit, runInBlockMode);
    if (!runInBlockMode) {
      store.commit();
    }
    if (shouldPrintStats) {
      const cranks = getCrankNumber();
      printStats(controller.getStats(), cranks);
    }
    if (benchmarkRounds > 0) {
      const [moreSteps, moreDeltaT] = await runBenchmark(benchmarkRounds);
      totalSteps += moreSteps;
      deltaT += moreDeltaT;
    }
    store.close();
    if (bootstrapResult) {
      const status = bootstrapResult.status();
      if (status === 'pending') {
        log('bootstrap result still pending');
      } else {
        const resolution = JSON.stringify(bootstrapResult.resolution());
        log(`bootstrap result ${status}: ${resolution}`);
        bootstrapResult = null;
      }
    }
    if (logTimes) {
      if (totalSteps) {
        const per = deltaT / BigInt(totalSteps);
        log(
          `runner finished ${totalSteps} cranks in ${deltaT} ns (${per}/crank)`,
        );
      } else {
        log(`runner finished replay in ${deltaT} ns`);
      }
    } else {
      if (totalSteps) {
        log(`runner finished ${totalSteps} cranks`);
      } else {
        log(`runner finished replay`);
      }
    }
  }
}
