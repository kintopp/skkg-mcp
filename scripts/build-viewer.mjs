// Builds apps/image-viewer/ into the committed, stamped src/apps/image-viewer.html.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'vite';
import { viewerSourceHash, stamp, VIEWER_SRC_DIR, VIEWER_HTML } from './viewer-hash.mjs';
import { licenceNotices } from './viewer-licences.mjs';

const seen = new Set();
const collectPackages = {
  name: 'skkg:collect-packages',
  buildEnd() {
    for (const id of this.getModuleIds()) {
      const pkg = id.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//)?.[1];
      if (pkg) seen.add(pkg);
    }
  },
};

const { output } = await build({ configFile: join(VIEWER_SRC_DIR, 'vite.config.mjs'), logLevel: 'warn', plugins: [collectPackages] });

const bundled = [...seen].sort();
const html = String(output.find((f) => f.fileName === 'index.html').source);
const notices = `<!--\nThird-party software bundled in this page:\n\n${licenceNotices(bundled)}\n-->`;
writeFileSync(VIEWER_HTML, `${stamp(bundled, viewerSourceHash(bundled))}\n${notices}\n${html}`);
console.error(`wrote ${VIEWER_HTML} (${Math.round(html.length / 1024)} KB)`);
