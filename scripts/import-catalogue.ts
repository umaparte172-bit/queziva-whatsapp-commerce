import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

/**
 * Imports products from the client's catalogue spreadsheet (the "Catalogue" sheet) into the
 * database, matched by SKU. Existing products are updated in place; stock is left untouched on
 * update, since it's managed from the dashboard as sales happen, not from the spreadsheet.
 *
 * Usage: npx tsx scripts/import-catalogue.ts <path-to.xlsx> [--gst-bps=0]
 *   [--image-base-url=https://queziva.com/catalogue] [--dry-run]
 *
 * Requires the `unzip` command (an .xlsx is a zip file); present on Linux/macOS and in Git Bash
 * on Windows, which is what this project's tooling already assumes.
 */

type Row = string[];

function readSheet(xlsxPath: string, sheetName: string): Row[] {
  const dir = mkdtempSync(join(tmpdir(), 'xlsx-'));
  try {
    execFileSync('unzip', ['-o', '-q', xlsxPath, '-d', dir]);
    const dec = (s: string) =>
      s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');

    const sharedStrings = [
      ...readFileSync(join(dir, 'xl/sharedStrings.xml'), 'utf8').matchAll(/<si>([\s\S]*?)<\/si>/g),
    ].map((m) => dec([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));

    const workbook = readFileSync(join(dir, 'xl/workbook.xml'), 'utf8');
    const sheetMeta = [...workbook.matchAll(/<sheet [^>]*name="([^"]+)"[^>]*r:id="(rId\d+)"/g)];
    const match = sheetMeta.find(([, name]) => name === sheetName);
    if (!match) throw new Error(`Sheet "${sheetName}" not found. Sheets in file: ${sheetMeta.map((m) => m[1]).join(', ')}`);
    const rels = readFileSync(join(dir, 'xl/_rels/workbook.xml.rels'), 'utf8');
    const target = rels.match(new RegExp(`Id="${match[2]}"[^>]*Target="([^"]+)"`))?.[1];
    if (!target) throw new Error(`Could not resolve sheet "${sheetName}" to a worksheet file`);

    const colIndex = (ref: string) =>
      ref
        .replace(/\d+/g, '')
        .split('')
        .reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

    const xml = readFileSync(join(dir, 'xl', target), 'utf8');
    const rows: Row[] = [];
    for (const r of xml.matchAll(/<row [^>]*>([\s\S]*?)<\/row>/g)) {
      const row: Row = [];
      for (const c of r[1].matchAll(/<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[2];
        const inner = c[3] ?? '';
        let v: string | undefined = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        if (/t="s"/.test(attrs) && v !== undefined) v = sharedStrings[+v];
        else if (/t="inlineStr"/.test(attrs)) v = dec(inner.replace(/<[^>]+>/g, ''));
        else if (v !== undefined) v = dec(v);
        row[colIndex(c[1])] = v ?? '';
      }
      rows.push(row);
    }
    return rows;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** "Crystal Square Drop Earrings | QZ-EAR-001 | Queziva" → "Crystal Square Drop Earrings" */
function productName(title: string, sku: string): string {
  const prefix = title.split('|')[0]?.trim();
  return prefix || `${sku} (name pending)`;
}

async function main() {
  const args = process.argv.slice(2);
  const xlsxPath = args.find((a) => !a.startsWith('--'));
  const dryRun = args.includes('--dry-run');
  const gstArg = args.find((a) => a.startsWith('--gst-bps='));
  const imageBaseArg = args.find((a) => a.startsWith('--image-base-url='));
  const imageBaseUrl = imageBaseArg?.slice('--image-base-url='.length).replace(/\/$/, '');
  const gstRateBps = gstArg ? Number(gstArg.split('=')[1]) : undefined;
  if (!xlsxPath) {
    console.error(
      'Usage: npx tsx scripts/import-catalogue.ts <path-to.xlsx> [--gst-bps=0] ' +
        '[--image-base-url=https://queziva.com/catalogue] [--dry-run]',
    );
    process.exitCode = 1;
    return;
  }

  const rows = readSheet(xlsxPath, 'Catalogue');
  const [header, ...data] = rows;
  const col = (label: string) => {
    const i = header.findIndex((h) => h?.startsWith(label));
    if (i === -1) throw new Error(`Column starting with "${label}" not found. Headers: ${header.join(' | ')}`);
    return i;
  };
  const iSku = col('SKU');
  const iTitle = col('Product Catalogue Title');
  const iDesc = col('Product Catalogue Description');
  const iLink = col('Google Drive Link');
  const iDiscPrice = col('Selling Discounted Price');
  const iStock = col('Stock');
  const iGst = col('GST Price');

  const prisma = new PrismaClient();
  let created = 0;
  let updated = 0;
  const warnings: string[] = [];

  for (const row of data) {
    const sku = row[iSku]?.trim();
    if (!sku) continue;
    const title = row[iTitle]?.trim() ?? '';
    const pricePaise = Math.round(Number(row[iDiscPrice]) * 100);
    if (!Number.isFinite(pricePaise) || pricePaise <= 0) {
      warnings.push(`${sku}: no valid selling price ("${row[iDiscPrice]}") – skipped`);
      continue;
    }
    const rowGst = row[iGst]?.trim();
    const gst = gstRateBps ?? (rowGst ? Math.round(Number(rowGst) * 100) : 0); // sheet leaves GST blank – "not applicable for now"
    const driveLink = row[iLink]?.trim();

    const data_ = {
      retailerId: sku,
      name: productName(title, sku),
      description: row[iDesc]?.trim() || undefined,
      imageUrl: imageBaseUrl
        ? `${imageBaseUrl}/${encodeURIComponent(sku)}.jpg`
        : driveLink && /^https?:\/\//.test(driveLink)
          ? driveLink
          : undefined,
      pricePaise,
      gstRateBps: gst,
      hsnCode: '7117', // jewellery; matches the rest of the catalogue
    };

    if (dryRun) {
      console.log(`[dry run] ${sku}: ₹${(pricePaise / 100).toFixed(2)}, GST ${gst / 100}%, "${data_.name}"`);
      continue;
    }

    const existing = await prisma.product.findUnique({ where: { sku } });
    if (existing) {
      await prisma.product.update({ where: { sku }, data: data_ });
      updated++;
    } else {
      await prisma.product.create({
        data: {
          sku,
          ...data_,
          stock: Number(row[iStock]) || 0,
          // Real packed weight/box size aren't in the spreadsheet – these placeholders MUST be
          // corrected per product before go-live, since Shiprocket's rate depends on them.
          weightGrams: 100,
          lengthCm: 10,
          breadthCm: 10,
          heightCm: 5,
        },
      });
      created++;
    }
  }

  await prisma.$disconnect();
  if (dryRun) {
    console.log(`\nDry run: ${data.length} rows read, ${warnings.length} warning(s).`);
  } else {
    console.log(`\nImported: ${created} created, ${updated} updated, ${warnings.length} warning(s).`);
    if (created > 0) {
      console.log(
        'New products use placeholder packed weight (100g) and box size (10×10×5cm) – set the real ' +
          'values in Products & stock before going live, or Shiprocket quotes will be wrong.',
      );
    }
  }
  warnings.forEach((w) => console.warn('  ⚠ ' + w));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
