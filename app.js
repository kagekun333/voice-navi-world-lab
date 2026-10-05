class BrowserSpeechProvider {
  constructor() { this.synth = window.speechSynthesis; }
  available() { return Boolean(this.synth && window.SpeechSynthesisUtterance); }
  voices() { return this.available() ? this.synth.getVoices() : []; }
  bestVoice(languageTag) {
    const voices = this.voices();
    const exact = voices.find(v => v.lang.toLowerCase() === languageTag.toLowerCase());
    if (exact) return exact;
    const root = languageTag.split('-')[0].toLowerCase();
    return voices.find(v => v.lang.toLowerCase().split('-')[0] === root) || null;
  }
  speak(text, languageTag) {
    if (!this.available()) throw new Error('Browser speech is unavailable.');
    this.stop();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = languageTag;
    const voice = this.bestVoice(languageTag);
    if (voice) utterance.voice = voice;
    this.synth.speak(utterance);
    return voice;
  }
  stop() { if (this.available()) this.synth.cancel(); }
}

class LocalFeedbackProvider {
  constructor(storage = window.localStorage) {
    this.storage = storage;
    this.key = 'voice-navi-world-lab-feedback-v1';
  }

  read() {
    try {
      const value = JSON.parse(this.storage.getItem(this.key) || '{}');
      return { favorites: Array.isArray(value.favorites) ? value.favorites : [], reviews: value.reviews || {} };
    } catch (_) {
      return { favorites: [], reviews: {} };
    }
  }

  write(value) { this.storage.setItem(this.key, JSON.stringify(value)); }

  isFavorite(packID) { return this.read().favorites.includes(packID); }

  toggleFavorite(packID) {
    const value = this.read();
    const set = new Set(value.favorites);
    if (set.has(packID)) set.delete(packID); else set.add(packID);
    value.favorites = [...set].sort();
    this.write(value);
    return set.has(packID);
  }

  reviewKey(pack, phrase) { return `${pack.packID}@${pack.version}:${phrase.id}`; }

  getReview(pack, phrase) { return this.read().reviews[this.reviewKey(pack, phrase)] || null; }

  saveReview(pack, phrase, review) {
    const value = this.read();
    value.reviews[this.reviewKey(pack, phrase)] = review;
    this.write(value);
  }

  clearReview(pack, phrase) {
    const value = this.read();
    delete value.reviews[this.reviewKey(pack, phrase)];
    this.write(value);
  }
}

const speech = new BrowserSpeechProvider();
const feedback = new LocalFeedbackProvider();
const state = { catalog: null, language: null, market: 'ALL', pack: null, phrase: null, search: '', favoritesOnly: false };
const $ = id => document.getElementById(id);

function titleCase(value) {
  if (!value) return 'Not recorded';
  return value.split(/[-_]/).map(part => part ? part[0].toUpperCase() + part.slice(1) : part).join(' ');
}

function languageLabel(root) {
  try { return new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' }).of(root) || root.toUpperCase(); }
  catch (_) { return root.toUpperCase(); }
}

function regionLabel(code) {
  if (!code) return 'Other / base';
  try { return new Intl.DisplayNames([navigator.language || 'en'], { type: 'region' }).of(code) || code; }
  catch (_) { return code; }
}

function allLanguagePacks() {
  return state.catalog.packs.filter(pack => pack.languageRoot === state.language);
}

function filteredPacks() {
  const query = state.search.trim().toLowerCase();
  const favorites = new Set(feedback.read().favorites);
  return allLanguagePacks().filter(pack => {
    if (state.favoritesOnly && !favorites.has(pack.packID)) return false;
    if (state.market !== 'ALL' && (pack.regionCode || 'OTHER') !== state.market) return false;
    if (!query) return true;
    return [pack.displayName, pack.region, pack.dialectID, pack.packID, pack.languageTag]
      .filter(Boolean).some(value => value.toLowerCase().includes(query));
  });
}

function option(value, label) {
  const el = document.createElement('option');
  el.value = value; el.textContent = label; return el;
}

function deepLinkURL(pack = state.pack, phrase = state.phrase) {
  const url = new URL(window.location.href);
  url.search = '';
  if (pack) url.searchParams.set('pack', pack.packID);
  if (phrase) url.searchParams.set('phrase', phrase.id);
  return url.toString();
}

function syncURL() {
  if (!state.pack) return;
  history.replaceState(null, '', deepLinkURL());
}

function applyDeepLink() {
  const params = new URLSearchParams(window.location.search);
  const packID = params.get('pack');
  const phraseID = params.get('phrase');
  if (!packID) return false;
  const pack = state.catalog.packs.find(item => item.packID === packID);
  if (!pack) return false;

  state.language = pack.languageRoot;
  $('language-select').value = state.language;
  renderMarketOptions();
  state.market = pack.regionCode || 'ALL';
  if ([...$('market-select').options].some(option => option.value === state.market)) $('market-select').value = state.market;
  state.search = ''; $('pack-search').value = '';
  renderPackOptions();
  state.pack = pack; $('pack-select').value = pack.packID; renderPack();
  if (phraseID) {
    const phrase = pack.phrases.find(item => item.id === phraseID);
    if (phrase) { state.phrase = phrase; $('phrase-select').value = phrase.id; renderPhrase(); }
  }
  return true;
}

function renderLanguageOptions() {
  const roots = [...new Set(state.catalog.packs.map(pack => pack.languageRoot))].sort();
  $('language-select').replaceChildren(...roots.map(root => option(root, `${languageLabel(root)} (${state.catalog.packs.filter(p => p.languageRoot === root).length})`)));
  const browserRoot = (navigator.language || '').split('-')[0].toLowerCase();
  state.language = roots.includes(browserRoot) ? browserRoot : (roots.includes('ja') ? 'ja' : roots[0]);
  $('language-select').value = state.language;
  $('language-count').textContent = String(roots.length);
}

function renderMarketOptions() {
  const packs = allLanguagePacks();
  const counts = new Map();
  packs.forEach(pack => {
    const code = pack.regionCode || 'OTHER';
    counts.set(code, (counts.get(code) || 0) + 1);
  });
  const codes = [...counts.keys()].sort((a,b) => regionLabel(a === 'OTHER' ? null : a).localeCompare(regionLabel(b === 'OTHER' ? null : b)));
  $('market-select').replaceChildren(
    option('ALL', `All markets (${packs.length})`),
    ...codes.map(code => option(code, `${regionLabel(code === 'OTHER' ? null : code)} (${counts.get(code)})`))
  );
  state.market = 'ALL';
  $('market-select').value = 'ALL';
}

function renderPackOptions({ preserveSelection = false } = {}) {
  const packs = filteredPacks().sort((a, b) => a.displayName.localeCompare(b.displayName));
  const previousID = preserveSelection ? state.pack?.packID : null;
  const previousPhraseID = preserveSelection ? state.phrase?.id : null;
  $('pack-select').replaceChildren(...packs.map(pack => option(pack.packID, pack.displayName)));
  state.pack = packs.find(pack => pack.packID === previousID)
    || packs.find(pack => pack.dialectID === 'standard')
    || packs[0]
    || null;
  $('pack-select').disabled = packs.length === 0;
  if (state.pack) $('pack-select').value = state.pack.packID;
  renderPack();
  if (preserveSelection && state.pack?.packID === previousID && previousPhraseID) {
    const phrase = state.pack.phrases.find(item => item.id === previousPhraseID);
    if (phrase) {
      state.phrase = phrase;
      $('phrase-select').value = phrase.id;
      renderPhrase();
    }
  }
}

function updateFavoriteButton() {
  const button = $('favorite-button');
  if (!state.pack) {
    button.disabled = true;
    button.setAttribute('aria-pressed', 'false');
    button.textContent = '☆ Favorite';
    return;
  }
  const active = feedback.isFavorite(state.pack.packID);
  button.disabled = false;
  button.setAttribute('aria-pressed', String(active));
  button.textContent = active ? '★ Favorited' : '☆ Favorite';
}

function packReviews(pack = state.pack) {
  if (!pack) return [];
  return pack.phrases.flatMap(phrase => {
    const review = feedback.getReview(pack, phrase);
    return review ? [{ phrase, review }] : [];
  });
}

function updateReviewProgress() {
  const total = state.pack?.phrases.length || 0;
  const reviewed = packReviews().length;
  $('review-progress-count').textContent = `${reviewed} / ${total}`;
  $('copy-pack-review-button').disabled = reviewed === 0;
  $('next-review-button').disabled = total === 0 || reviewed >= total;
}

function selectReviewPhrase(phrase) {
  if (!state.pack || !phrase) return;
  state.phrase = phrase;
  $('phrase-select').value = phrase.id;
  renderPhrase();
  syncURL();
}

function nextUnreviewedPhrase() {
  const pack = state.pack;
  if (!pack || !pack.phrases.length) return null;
  const start = Math.max(0, pack.phrases.findIndex(phrase => phrase.id === state.phrase?.id));
  for (let offset = 1; offset <= pack.phrases.length; offset += 1) {
    const phrase = pack.phrases[(start + offset) % pack.phrases.length];
    if (!feedback.getReview(pack, phrase)) return phrase;
  }
  return null;
}

function packReviewPayload() {
  if (!state.pack) return null;
  const reviews = packReviews().map(({ phrase, review }) => ({
    phraseID: phrase.id,
    phraseText: phrase.text,
    nativeSpeaker: Boolean(review.nativeSpeaker),
    wordingRating: review.wordingRating || null,
    note: review.note || ''
  }));
  return {
    schemaVersion: '0.1.0',
    kind: 'pack-wording-review',
    packID: state.pack.packID,
    packVersion: state.pack.version,
    displayName: state.pack.displayName,
    languageTag: state.pack.languageTag,
    region: state.pack.region || null,
    dialectID: state.pack.dialectID || null,
    reviewedPhraseCount: reviews.length,
    totalPhraseCount: state.pack.phrases.length,
    browserSpeechPreviewOnly: true,
    reviews
  };
}

function selectedWordingRating() {
  return document.querySelector('input[name="wording-rating"]:checked')?.value || null;
}

function loadReviewForm() {
  const pack = state.pack;
  const phrase = state.phrase;
  const disabled = !pack || !phrase;
  $('feedback-pack').textContent = pack ? `${pack.displayName} · v${pack.version}` : '—';
  $('feedback-phrase').textContent = phrase ? phrase.text : '—';
  $('native-speaker').disabled = disabled;
  $('review-note').disabled = disabled;
  $('save-review-button').disabled = disabled;
  $('copy-review-button').disabled = disabled;
  $('clear-review-button').disabled = disabled;
  updateReviewProgress();
  document.querySelectorAll('input[name="wording-rating"]').forEach(input => { input.disabled = disabled; input.checked = false; });
  $('native-speaker').checked = false;
  $('review-note').value = '';
  if (disabled) { $('feedback-status').textContent = 'Select a pack and phrase first.'; return; }

  const review = feedback.getReview(pack, phrase);
  if (!review) { $('feedback-status').textContent = 'No review saved for this phrase yet.'; return; }
  $('native-speaker').checked = Boolean(review.nativeSpeaker);
  $('review-note').value = review.note || '';
  const rating = document.querySelector(`input[name="wording-rating"][value="${review.wordingRating}"]`);
  if (rating) rating.checked = true;
  $('feedback-status').textContent = 'Saved locally on this device.';
}

function reviewPayload() {
  if (!state.pack || !state.phrase) return null;
  return {
    schemaVersion: '0.1.0',
    kind: 'wording-review',
    packID: state.pack.packID,
    packVersion: state.pack.version,
    displayName: state.pack.displayName,
    languageTag: state.pack.languageTag,
    region: state.pack.region || null,
    dialectID: state.pack.dialectID || null,
    phraseID: state.phrase.id,
    phraseText: state.phrase.text,
    nativeSpeaker: $('native-speaker').checked,
    wordingRating: selectedWordingRating(),
    note: $('review-note').value.trim(),
    browserSpeechPreviewOnly: true
  };
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement('textarea');
  area.value = text; area.style.position = 'fixed'; area.style.opacity = '0';
  document.body.appendChild(area); area.select(); document.execCommand('copy'); area.remove();
}

function renderPack() {
  const pack = state.pack;
  if (!pack) {
    $('readiness-badge').textContent = 'NO MATCH';
    $('pack-name').textContent = 'No matching voice pack';
    $('pack-meta').textContent = 'Change the market filter or search text.';
    $('pack-version').textContent = '—';
    $('public-language').textContent = '—';
    $('public-style').textContent = '—';
    $('phrase-select').replaceChildren();
    $('phrase-text').textContent = '—';
    $('speak-button').disabled = true;
    $('share-button').disabled = true;
    $('share-status').textContent = '';
    updateFavoriteButton();
    state.phrase = null;
    loadReviewForm();
    return;
  }
  $('share-button').disabled = false;
  $('share-status').textContent = '';
  $('readiness-badge').textContent = 'PUBLIC BETA';
  $('pack-name').textContent = pack.displayName;
  $('pack-meta').textContent = [pack.languageTag, pack.region, pack.dialectID].filter(Boolean).join(' · ');
  $('pack-version').textContent = `v${pack.version}`;
  $('public-language').textContent = languageLabel(pack.languageRoot);
  $('public-style').textContent = titleCase(pack.dialectID || 'standard');
  updateFavoriteButton();

  $('phrase-select').replaceChildren(...pack.phrases.map(phrase => option(phrase.id, phrase.label)));
  state.phrase = pack.phrases[0] || null;
  renderPhrase();
  updateVoiceStatus();
}

function renderPhrase() {
  $('phrase-text').textContent = state.phrase?.text || 'No preview phrase available.';
  $('speak-button').disabled = !speech.available() || !state.phrase;
  loadReviewForm();
}

function updateVoiceStatus(voice = null) {
  if (!speech.available()) { $('voice-status').textContent = 'Browser speech is not available in this browser.'; return; }
  if (!state.pack) { $('voice-status').textContent = 'Select a voice pack to preview.'; return; }
  const selected = voice || speech.bestVoice(state.pack.languageTag);
  $('voice-status').textContent = selected
    ? `Browser preview voice: ${selected.name} (${selected.lang}). Final regional delivery may differ.`
    : `No matching system voice is currently exposed for ${state.pack.languageTag}. Wording remains available.`;
}

async function loadCatalog() {
  const response = await fetch('data/catalog.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Catalog request failed: ${response.status}`);
  state.catalog = await response.json();
  $('pack-count').textContent = String(state.catalog.packCount);
  renderLanguageOptions(); renderMarketOptions(); renderPackOptions();
  if (!applyDeepLink()) syncURL();
  if (new URLSearchParams(window.location.search).get('review') === '1') {
    requestAnimationFrame(() => $('feedback-title').scrollIntoView({ block: 'start' }));
  }
}

$('language-select').addEventListener('change', event => {
  speech.stop(); state.language = event.target.value; state.search = ''; $('pack-search').value = '';
  renderMarketOptions(); renderPackOptions(); syncURL();
});
$('market-select').addEventListener('change', event => {
  speech.stop(); state.market = event.target.value; renderPackOptions(); syncURL();
});
$('pack-search').addEventListener('input', event => {
  speech.stop(); state.search = event.target.value; renderPackOptions({ preserveSelection: true }); syncURL();
});
$('pack-select').addEventListener('change', event => {
  speech.stop(); state.pack = state.catalog.packs.find(pack => pack.packID === event.target.value) || null; renderPack(); syncURL();
});
$('phrase-select').addEventListener('change', event => {
  speech.stop(); state.phrase = state.pack?.phrases.find(phrase => phrase.id === event.target.value) || null; renderPhrase(); syncURL();
});
$('share-button').addEventListener('click', async () => {
  if (!state.pack) return;
  const url = deepLinkURL();
  try {
    if (navigator.share) {
      await navigator.share({ title: `VOICE NAVI — ${state.pack.displayName}`, text: 'Preview this VOICE NAVI navigation voice pack.', url });
      $('share-status').textContent = 'Share sheet opened.';
    } else {
      await copyText(url);
      $('share-status').textContent = 'Pack link copied.';
    }
  } catch (_) {
    $('share-status').textContent = `Share link: ${url}`;
  }
});
$('favorite-button').addEventListener('click', () => {
  if (!state.pack) return;
  feedback.toggleFavorite(state.pack.packID);
  updateFavoriteButton();
  if (state.favoritesOnly) renderPackOptions({ preserveSelection: true });
});
$('favorites-filter').addEventListener('click', () => {
  state.favoritesOnly = !state.favoritesOnly;
  $('favorites-filter').setAttribute('aria-pressed', String(state.favoritesOnly));
  $('favorites-filter').textContent = state.favoritesOnly ? '★ Showing favorites' : '☆ Favorites only';
  renderPackOptions({ preserveSelection: true });
});
$('save-review-button').addEventListener('click', () => {
  const payload = reviewPayload();
  if (!payload) return;
  feedback.saveReview(state.pack, state.phrase, {
    nativeSpeaker: payload.nativeSpeaker, wordingRating: payload.wordingRating, note: payload.note
  });
  updateReviewProgress();
  $('feedback-status').textContent = 'Saved locally on this device. Nothing was uploaded.';
});
$('clear-review-button').addEventListener('click', () => {
  if (!state.pack || !state.phrase) return;
  feedback.clearReview(state.pack, state.phrase);
  loadReviewForm();
});
$('next-review-button').addEventListener('click', () => {
  const next = nextUnreviewedPhrase();
  if (next) selectReviewPhrase(next);
  else $('feedback-status').textContent = 'All preview phrases for this pack have local reviews.';
});
$('copy-pack-review-button').addEventListener('click', async () => {
  const payload = packReviewPayload();
  if (!payload) return;
  try {
    await copyText(JSON.stringify(payload, null, 2));
    $('feedback-status').textContent = `Copied ${payload.reviewedPhraseCount} saved phrase reviews for this pack.`;
  } catch (_) {
    $('feedback-status').textContent = 'Could not copy pack reviews automatically. Local reviews are unchanged.';
  }
});
$('copy-review-button').addEventListener('click', async () => {
  const payload = reviewPayload();
  if (!payload) return;
  try {
    await copyText(JSON.stringify(payload, null, 2));
    $('feedback-status').textContent = 'Review packet copied. No data was uploaded.';
  } catch (_) {
    $('feedback-status').textContent = 'Could not copy automatically. Your local review is unchanged.';
  }
});
$('speak-button').addEventListener('click', () => {
  try { updateVoiceStatus(speech.speak(state.phrase.text, state.pack.languageTag)); }
  catch (error) { $('voice-status').textContent = error.message; }
});
$('stop-button').addEventListener('click', () => speech.stop());
if (speech.available()) speech.synth.addEventListener?.('voiceschanged', () => updateVoiceStatus());

let deferredInstallPrompt = null;
const installButton = $('install-button');
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  deferredInstallPrompt = event;
  installButton.hidden = false;
});
installButton.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  try { await deferredInstallPrompt.userChoice; } catch (_) {}
  deferredInstallPrompt = null;
  installButton.hidden = true;
});
window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  installButton.hidden = true;
});

if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('service-worker.js').catch(() => {}));
loadCatalog().catch(error => {
  $('pack-name').textContent = 'Catalog unavailable'; $('pack-meta').textContent = error.message; $('speak-button').disabled = true;
});
