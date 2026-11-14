// Unit tests for the Drive helpers that need no browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickSubtitle, DriveClient } from '../public/assets/js/drive.js';

const sub = (name) => ({ kind: 'subtitle', name });
const pick = (movie, names, lang) => pickSubtitle(movie, names.map(sub), lang)?.name ?? null;

test('exact base name wins over suffixed files', () => {
  assert.equal(pick('Arrival.mkv', ['Arrival.en.srt', 'Arrival.srt', 'Arrival.it.srt'], 'it'), 'Arrival.srt');
});

test('matching is case-insensitive and needs the whole base name', () => {
  assert.equal(pick('arrival.MKV', ['ARRIVAL.EN.SRT']), 'ARRIVAL.EN.SRT');
  assert.equal(pick('Arrival.mkv', ['Arrival 2.srt', 'Arrivals.srt', 'Other.srt'], 'en'), null);
  assert.equal(pick('Arrival.mkv', ['Arrival.2016.srt', 'Other.srt']), 'Arrival.2016.srt');
});

test('prefers the browser language, as a 2-letter or ISO 639-2 suffix', () => {
  assert.equal(pick('A.mkv', ['A.en.srt', 'A.it.srt', 'A.fr.srt'], 'it-IT'), 'A.it.srt');
  assert.equal(pick('A.mkv', ['A.eng.srt', 'A.ita.srt'], 'it'), 'A.ita.srt');
  assert.equal(pick('A.mkv', ['A.eng.srt', 'A.ita.srt'], 'en-US'), 'A.eng.srt');
  assert.equal(pick('A.mkv', ['A.deu.srt', 'A.ger.srt'], 'de'), 'A.deu.srt');
});

test('prefers non-forced, then the first by name', () => {
  assert.equal(pick('A.mkv', ['A.eng.forced.srt', 'A.fr.srt'], 'xx'), 'A.fr.srt');
  assert.equal(pick('A.mkv', ['A.eng.forced.srt', 'A.it.forced.srt'], 'it'), 'A.it.forced.srt');
  assert.equal(pick('A.mkv', ['A.b.srt', 'A.a.srt'], ''), 'A.a.srt');
  assert.equal(pick('A.mkv', ['A.forced.en.srt', 'A.en.srt'], 'en'), 'A.en.srt');
});

test('ignores non-subtitle entries and handles empty input', () => {
  assert.equal(pickSubtitleOf([{ kind: 'video', name: 'A.srt' }]), null);
  assert.equal(pick('A.mkv', []), null);
  assert.equal(pick('A', ['A.srt']), 'A.srt');
});
function pickSubtitleOf(files) { return pickSubtitle('A.mkv', files, 'en'); }

test('addKey validates ids and keys and never overwrites a known key', () => {
  const d = new DriveClient({ apiKey: 'k', folderId: 'ROOTFOLDER_0001', resourceKey: 'R-1' });
  d.addKey('SUBFOLDER_00002', 'S-1');
  d.addKey('SUBFOLDER_00002', 'OTHER');
  d.addKey('bad id!', 'X');
  d.addKey('THIRDFOLDER_0003', 'bad key,/');
  d.addKey('FOURTHFOLDER_004', '');
  assert.deepEqual([...d.keys], [['ROOTFOLDER_0001', 'R-1'], ['SUBFOLDER_00002', 'S-1']]);
});
