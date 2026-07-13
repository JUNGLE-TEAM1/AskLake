import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultOutputPath = path.resolve(scriptDir, "../fixtures/kafka/amazon-review-fixture.jsonl");
const options = parseArgs(process.argv.slice(2));
const count = positiveInteger(options.count, "count") || 100;
const outputPath = path.resolve(process.cwd(), options.output || defaultOutputPath);

const products = [
  ["headphones", "Electronics"],
  ["coffee grinder", "Home & Kitchen"],
  ["backpack", "Luggage"],
  ["desk lamp", "Office Products"],
  ["cotton shirt", "Clothing"],
  ["tablet case", "Electronics"],
  ["dog bed", "Pet Supplies"],
  ["air filters", "Home Improvement"],
  ["board game", "Toys & Games"],
  ["sunscreen", "Beauty"],
  ["running shoes", "Shoes"],
  ["external drive", "Computers"],
  ["picture frame", "Home Decor"],
  ["cast iron pan", "Kitchen"],
  ["phone charger", "Cell Phones & Accessories"],
  ["notebook", "Office Products"],
  ["garden hose", "Patio, Lawn & Garden"],
  ["protein bars", "Grocery"],
  ["Bluetooth speaker", "Electronics"],
  ["curtain panels", "Home & Kitchen"],
  ["travel mug", "Kitchen"],
  ["yoga mat", "Sports & Outdoors"],
  ["keyboard", "Computers"],
  ["face moisturizer", "Beauty"],
  ["bookshelf", "Furniture"],
];

const sentiments = [
  {
    overall: 5,
    summary: "Exceeded expectations",
    text: (product) => `The ${product} arrived quickly, worked right away, and felt better made than I expected.`,
  },
  {
    overall: 4,
    summary: "Solid purchase",
    text: (product) => `The ${product} does the job well, though one small detail could be improved for daily use.`,
  },
  {
    overall: 3,
    summary: "Mixed experience",
    text: (product) => `The ${product} is useful, but the fit and finish feel uneven after a few days.`,
  },
  {
    overall: 2,
    summary: "Quality concern",
    text: (product) => `The ${product} looked promising, but a key part felt flimsy and made me question the durability.`,
  },
];

const baseTimestamp = Date.UTC(2026, 6, 9, 0, 0, 0, 0);
const records = Array.from({ length: count }, (_, index) => buildRecord(index + 1));
writeFileSync(outputPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
console.log(`Generated ${records.length} review fixture records at ${outputPath}`);

function buildRecord(offset) {
  const [product, category] = products[(offset - 1) % products.length];
  const sentiment = sentiments[Math.floor((offset - 1) / products.length) % sentiments.length];
  const createdAt = new Date(baseTimestamp + (offset - 1) * 60_000);
  const reviewText = sentiment.text(product);

  return {
    schema_version: "1.0",
    event_id: `amazon-review-${String(offset).padStart(6, "0")}`,
    source: "amazon-review-fixture",
    offset,
    review: reviewText,
    created_at: createdAt.toISOString(),
    raw: {
      reviewerID: `A1FIXTURE${String(offset).padStart(4, "0")}`,
      asin: `B000ASK${String(offset).padStart(3, "0")}`,
      reviewText,
      summary: sentiment.summary,
      overall: sentiment.overall,
      unixReviewTime: Math.floor(createdAt.getTime() / 1000),
      reviewTime: "07 9, 2026",
      category,
    },
  };
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) throw new Error(`Unknown positional argument: ${arg}`);
    const equalsIndex = arg.indexOf("=");
    const rawKey = equalsIndex === -1 ? arg.slice(2) : arg.slice(2, equalsIndex);
    const inlineValue = equalsIndex === -1 ? undefined : arg.slice(equalsIndex + 1);
    const value = inlineValue ?? argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for --${rawKey}`);
    parsed[camelCase(rawKey)] = value;
    if (inlineValue === undefined) index += 1;
  }
  return parsed;
}

function positiveInteger(value, label) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`--${label} must be a positive integer`);
  return number;
}

function camelCase(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}
