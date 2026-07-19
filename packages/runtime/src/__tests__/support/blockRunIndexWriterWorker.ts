import { recordBlockRunInIndex } from "../../autoRun/blockRunIndex.js";

const runIdWidth = 3;
const [runRoot, firstText, lastText] = process.argv.slice(2);
if (!(runRoot && firstText && lastText)) {
  throw new Error("Block run index writer requires runRoot, first, and last arguments.");
}
const first = Number.parseInt(firstText, 10);
const last = Number.parseInt(lastText, 10);
if (!(Number.isInteger(first) && Number.isInteger(last)) || first > last) {
  throw new Error("Block run index writer received an invalid range.");
}

for (let index = first; index <= last; index += 1) {
  await recordBlockRunInIndex(runRoot, `RUN-${String(index).padStart(runIdWidth, "0")}`);
}
