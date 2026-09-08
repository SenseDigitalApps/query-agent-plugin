#!/usr/bin/env node
// Reemplaza a node-edge-tts en los tests: sin esto, probar la sintesis de voz
// dependeria de una llamada real al servicio de Azure/Edge por red. Solo
// escribe un mp3 minimo (no valido, pero con bytes) en --filepath.
import { writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const filepath = flag("--filepath");
if (!filepath) {
  console.error("fake-tts: falta --filepath");
  process.exit(1);
}

await writeFile(filepath, Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00]));
process.exit(0);
