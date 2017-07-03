"use strict";

const fs = require("fs");
const atom = require("./lib/atom.js");
const iofs = require("./lib/iofs.js");

const hasOwn = Object.prototype.hasOwnProperty;
const AMDGPU_DRIVER_NAME = "amdgpu";

// ============================================================================
// [Utils]
// ============================================================================

class Utils {
  static pathOfCard(id) {
    return `/sys/class/drm/card${id}`;
  }

  static extractBIOS(id) {
    var buf = null;
    const romPath = `${Utils.pathOfCard(id)}/device/rom`;

    if (iofs.writeString(romPath, "1")) {
      buf = iofs.readFile(romPath);
      iofs.writeString(romPath, "0");
    }

    return buf;
  }
}

// ============================================================================
// [Commander]
// ============================================================================

class Commander {
  constructor(argv) {
    this.argv = argv; // Arguments array.
    this.argn = 2;    // Current argument index.
    this.verboseMessages = false;

    this.cards = [];  // IDs of all cards selected.
    this.data  = [];  // Data related to each card in `cards` array.
  }

  // --------------------------------------------------------------------------
  // [Logging]
  // --------------------------------------------------------------------------

  message(msg) {
    console.log(msg);
    return this;
  }

  verbose(msg) {
    if (this.verboseMessages)
      console.log(msg);
    return this;
  }

  warning(msg) {
    console.log(`WARNING: ${msg}`);
    return this;
  }

  error(msg) {
    console.log(`FAILED: ${msg}`);
    throw Error(msg);
  }

  // --------------------------------------------------------------------------
  // [Utilities]
  // --------------------------------------------------------------------------

  checkFileName(fileName) {
    if (this.cards.length > 1 && fileName.indexOf("@") === -1)
      this.error(`File name '${fileName}' must contain a '@' placeholder when multiple cards are selected`);
    return fileName;
  }

  // --------------------------------------------------------------------------
  // [Run]
  // --------------------------------------------------------------------------

  run() {
    const argv = this.argv;
    while (this.argn < argv.length) {
      const arg = argv[this.argn++];

      if (!arg.startsWith("--"))
        return this.error(`Invalid argument, each command must start with '--'`);

      const cmd = arg.replace(/-/g, "_");
      const fn = this[cmd];

      if (typeof fn !== "function")
        return this.error(`Command ${arg} doesn't exist`);

      const args = [];
      while (this.argn < argv.length && !argv[this.argn].startsWith("--"))
        args.push(argv[this.argn++]);

      fn.call(this, args);
    }

    return 0;
  }

  // --------------------------------------------------------------------------
  // [Options]
  // --------------------------------------------------------------------------

  __verbose(args) {
    if (args.length)
      this.error("--verbose parameter doesn't have any arguments");

    this.verboseMessages = true;
  }

  // --------------------------------------------------------------------------
  // [Card Management]
  // --------------------------------------------------------------------------

  addCard(id) {
    if (this.cards.indexOf(id) !== -1)
      return this.warning(`Card '${id}' already selected, skipping...`);

    // Check if this card exists and it's using AMDGPU driver.
    const props = iofs.readProperties(Utils.pathOfCard(id) + "/device/uevent");
    if (!props || props.DRIVER !== AMDGPU_DRIVER_NAME)
      return this.warning(`Card ${id} doesn't exist or it doesn't use AMDGPU driver`);

    this.addCardInternal(id);
  }

  addCardBySelector(s) {
    // Select one card by ID.
    if (/^\d+$/.test(s))
      return this.addCard(parseInt(s));

    // Select multiple cards separated by commas.
    if (/^(?:\d+,)+(\d+)$/.test(s)) {
      const array = s.split(",");
      for (var i = 0; i < array.length; i++)
        this.addCard(parseInt(array[i]));
      return;
    }

    // Select a range of card IDs.
    if (/^\d+-\d+$/.test(s)) {
      const bounds = s.split("-");
      var i = parseInt(bounds[0]);
      var j = parseInt(bounds[1]);

      while (i <= j) {
        this.addCard(i);
        i++;
      }

      return;
    }

    // Select all available cards.
    if (s === "@") {
      var id = 0;
      for (;;) {
        if (this.cards.indexOf(id) === -1) {
          const props = iofs.readProperties(Utils.pathOfCard(id) + "/device/uevent");
          if (!props)
            break;

          if (props.DRIVER === AMDGPU_DRIVER_NAME)
            this.addCardInternal(id);
        }

        id++;
      }
      return;
    }

    this.error(`Invalid card selector '${s}'`);
  }

  addCardInternal(id) {
    this.verbose(`Card '${id}' selected`);
    this.cards.push(id);
    this.data.push(Object.create(null));
  }

  __card(args) {
    if (args.length < 1)
      this.error(`'--card' command accepts at least one argument`);

    if (this.cards.length) {
      this.verbose(`Clearing a list of all selected cards`);
      this.cards.length = 0;
      this.data.length = 0;
    }

    var cards = [];
    for (var i = 0; i < args.length; i++)
      this.addCardBySelector(args[i]);

    if (this.cards === 0)
      this.warning("No cards selected, the following operations will have no effect");
  }

  // --------------------------------------------------------------------------
  // [Read / Write PowerPlay]
  // --------------------------------------------------------------------------

  __read_card_pp(args) {
    if (args.length !== 0)
      this.error(`'--read-card-pp' command accepts no arguments`);

    const data = this.data;
    const cards = this.cards;

    for (var i = 0; i < cards.length; i++) {
      const id = cards[i];
      const fileName = `${Utils.pathOfCard(id)}/device/pp_table`;

      const buf = iofs.readFile(fileName);
      if (!buf) {
        this.error(`Couldn't read PowerPlay table of card '${id}`);
      }
      else {
        const pp = atom.$decomposeData(buf, 0, atom.PowerPlayInfo);

        data[i].pp = pp;
        data[i].buf = buf;

        this.verbose(`Card '${id}' PP data loaded from '${fileName}'`);
      }
    }
  }

  __write_card_pp(args) {
    if (args.length !== 0)
      this.error(`'--write-card-pp' command accepts no arguments`);

    const data = this.data;
    const cards = this.cards;

    for (var i = 0; i < cards.length; i++) {
      const id = cards[i];
      const fileName = `${Utils.pathOfCard(id)}/device/pp_table`;

      const pp = data[i].pp;
      const buf = data[i].buf;

      if (!buf || !pp) {
        this.warning(`PP table of card '${id}' not loaded, cannot write it`);
        continue;
      }

      atom.$mergeData(buf, 0, null, pp);
      if (iofs.writeFile(fileName, buf)) {
        this.verbose(`Card '${id}' PP data written to '${fileName}'`);
      }
      else {
        this.warning(`Couldn't write PP table of card '${id}', are you root?`);
      }
    }
  }

  __read_file_pp(args) {
    if (args.length !== 1)
      this.error(`'--read-file-pp' command accepts exactly one argument`);

    const data = this.data;
    const cards = this.cards;

    const fileNameTemplate = this.checkFileName(args[0]);

    for (var i = 0; i < cards.length; i++) {
      const id = cards[i];
      const fileName = fileNameTemplate.replace("@", String(id));

      const buf = iofs.readFile(fileName);
      if (!buf) {
        this.error(`Couldn't read '${fileName}' file '${id}`);
      }
      else {
        const pp = atom.$decomposeData(buf, 0, atom.PowerPlayInfo);

        data[i].pp = pp;
        data[i].buf = buf;

        this.verbose(`Card '${id}' PP data loaded from '${fileName}'`);
      }
    }
  }

  __write_file_pp(args) {
    if (args.length !== 0)
      this.error(`'--write-file-pp' command accepts exactly one argument`);

    const data = this.data;
    const cards = this.cards;

    for (var i = 0; i < cards.length; i++) {
      const id = cards[i];
      const fileName = `${Utils.pathOfCard(id)}/device/pp_table`;

      const pp = data[i].pp;
      const buf = data[i].buf;

      if (!buf || !pp) {
        this.warning(`PP table of card '${id}' not loaded, cannot write it`);
        continue;
      }

      atom.$mergeData(buf, 0, null, pp);
      if (iofs.writeFile(fileName, buf)) {
        this.verbose(`Card '${id}' PP data written to '${fileName}'`);
      }
      else {
        this.warning(`Couldn't write PP table of card '${id}', are you root?`);
      }
    }
  }

  // --------------------------------------------------------------------------
  // [Set]
  // --------------------------------------------------------------------------

  __set(args) {
    if (args.length !== 1)
      this.error(`'--set' command accepts exactly one argument`);

    const cmd = args[0];
    const eqIndex = cmd.indexOf("=");

    if (eqIndex === -1)
      this.error(`'--set' command must be used with 'PROPERTY=VALUE' argument`);

    const key = cmd.substr(0, eqIndex);
    const value = cmd.substr(eqIndex + 1);

    const data = this.data;
    const cards = this.cards;

    for (var i = 0; i < cards.length; i++) {
      const id = cards[i];
      const pp = data[i].pp;

      if (!pp)
        this.error(`'--set' command requires PP table(s) to be loaded (card '${id}')`);

      this.setProperty(pp, "", key, value);
    }
  }

  setProperty(obj, path, key, value) {
    if (!key)
      this.error(`Key '${path}' is invalid`);

    const prefix = path ? path + "." : "";
    const m = key.match(/[\.\[]/);

    if (m) {
      // Object or array access.
      const what = m[0];
      const index = m.index;

      const thisKey = key.substring(0, index);
      if (!hasOwn.call(obj, thisKey))
        throw Error(`Key '${prefix + thisKey}' doesn't exist`);

      const thisObj = obj[thisKey];
      if (what === ".") {
        // Object access.
        if (thisObj == null || typeof thisObj !== "object" || Array.isArray(thisObj))
          this.error(`Key '${prefix + thisKey}' doesn't point to an Object`);

        const subKey = key.substring(index + 1);
        return this.setProperty(thisObj, prefix + thisKey, subKey, value);
      }
      else {
        // Array access.
        const endIndex = key.indexOf("]", index);
        if (endIndex === -1 )
          this.error(`Key '${prefix + key}' is invalid`);

        const indexValue = key.substring(index + 1, endIndex);
        if (!/^\d+$/.test(indexValue))
          this.error(`Key '${prefix + key}' is invalid`);

        if (!Array.isArray(thisObj))
          this.error(`Key '${prefix + thisKey}' doesn't point to an Array`);

        const i = parseInt(indexValue);
        if (i >= thisObj.length)
          this.error(`Key '${prefix + thisKey}' index '${i}' out of range [0, ${thisObj.length})`);

        const subKey = key.substring(endIndex + 1);
        if (subKey) {
          if (!subKey.startsWith("."))
            this.error(`Key '${prefix + thisKey}' is invalid`);
          return this.setProperty(thisObj[i], prefix + thisKey + `[${i}]`, subKey.substring(1), value);
        }
        else {
          // TODO:
        }
      }
    }
    else {
      if (!hasOwn.call(obj, key))
        this.error(`Key '${prefix + key}' doesn't exist`);

      const prev = obj[key];
      if (prev == null || typeof prev === "object")
        this.error(`Key '${prefix + key}' is an object, it cannot be set to '${value}'`);

      if (typeof prev === "number") {
        if (!/^-?\d+$/.test(value))
          this.error(`Key '${prefix + key}' points to a number, value '${value}' is invalid`);

        obj[key] = parseInt(value);
        return;
      }

      if (typeof prev === "string") {
        obj[key] = value;
        return;
      }

      this.error(`Key '${prefix + key}' exists, but couldn't find a right setter`);
    }
  }

  // --------------------------------------------------------------------------
  // [Print]
  // --------------------------------------------------------------------------

  __print(args) {
    if (args.length !== 0)
      this.error(`'--print' command accepts no arguments`);

    const data = this.data;
    const cards = this.cards;

    for (var i = 0; i < cards.length; i++) {
      const id = cards[i];
      const pp = data[i].pp;

      this.message(`Card '${id}': ` + JSON.stringify(pp, null, 2));
    }
  }

  // --------------------------------------------------------------------------
  // [Extract BIOS / PowerPlay]
  // --------------------------------------------------------------------------

  __extract_bios(args) {
    if (args.length !== 1)
      this.error(`'--extract-bios' accepts exactly one argument`);

    if (!this.cards.length)
      return;

    const cards = this.cards;
    const fileNameTemplate = this.checkFileName(args[0]);

    for (var i = 0; i < cards.length; i++) {
      const id = cards[i];
      const fileName = fileNameTemplate.replace("@", String(id));

      const buf = Utils.extractBIOS(id);
      if (!buf) {
        this.warning(`Couldn't extract BIOS of card '${id}, are you root?`);
      }
      else {
        if (!iofs.writeFile(fileName, buf))
          this.warning(`Couldn't write to '${fileName}'`);
      }
    }

    return;
  }

  __extract_bios_pp(args) {
    if (args.length !== 1)
      this.error(`'--extract-bios-pp' accepts exactly one argument`);

    if (!this.cards.length)
      return;

    const cards = this.cards;
    const fileNameTemplate = this.checkFileName(args[0]);

    for (var i = 0; i < cards.length; i++) {
      const id = cards[i];
      const fileName = fileNameTemplate.replace("@", String(id));

      const buf = Utils.extractBIOS(id);
      if (!buf) {
        this.warning(`Couldn't extract BIOS of card '${id}', are you root?`);
      }
      else {
        const pp = atom.extractVBIOSPowerPlayData(buf, 0);
        if (!pp) {
          this.warning(`Couldn't extract PowerPlay from BIOS of card '${id}', please report this!`);
        }
        else {
          if (!iofs.writeFile(fileName, pp))
            this.warning(`Couldn't write to '${fileName}'`);
        }
      }
    }

    return;
  }
}

// ============================================================================
// [Usage]
// ============================================================================

function printUsage() {
  console.log("Usage:");
  console.log("  amdtweak [commands...]");
  console.log("");
  console.log("Commands:");
  console.log("  --card X               - Select card to be used for all operations:");
  console.log("         @               - Select all available cards");
  console.log("         X-Y             - Select all available cards between X and Y, inclusive");
  console.log("         X,Y,...         - Select X, Y, possibly more cards");
  console.log("");
  console.log("  --read-card-pp         - Read a PowerPlay table from each selected card");
  console.log("  --write-card-pp        - Write a PowerPlay table to each selected card");
  console.log("");
  console.log("  --read-file-pp FILE    - Read a PowerPlay table from file");
  console.log("  --write-file-pp FILE   - Write a PowerPlay table to file");
  console.log("");
  console.log("  --extract-bios FILE    - Extract BIOS of each selected card and store to FILE");
  console.log("  --extract-bios-pp FILE - Extract PP from BIOS of each selected card and store to FILE");
  console.log("");
  console.log("  --set PROPERTY=VALUE   - Set a PROPERTY of each loaded PowerPlay table to VALUE");
  console.log("  --print                - Print each PowerPlay table as JSON");
  console.log("");
  console.log("Notes:");
  console.log("  - Commands are executed sequentially, one by one");
  console.log("  - Use @ as a placeholder that will be replaced by each card id");
}

// ============================================================================
// [Main]
// ============================================================================

function main(argv) {
  if (argv.length <= 2) {
    printUsage();
    return 0;
  }
  else {
    const commander = new Commander(argv);
    return commander.run();
  }
}

main(process.argv);
