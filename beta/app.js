class BrowserSpeechProvider {
  constructor() { this.synth = window.speechSynthesis; }
  available() { return Boolean(this.synth && window.SpeechSynthesisUtterance); }
  voices() { return this.available() ? [...this.synth.getVoices()] : []; }
  bestVoice(languageTag, options = {}) {
    const target = String(languageTag || '').toLowerCase().replaceAll('_', '-');
    if (!target) return null;
    const voices = this.voices().filter(v => options.allowRemote || v.localService !== false)
      .sort((a,b) => Number(b.localService === true) - Number(a.localService === true));
    const language = v => String(v.lang || '').toLowerCase().replaceAll('_', '-');
    const exact = voices.find(v => language(v) === target);
    if (exact) return exact;
    const root = target.split('-')[0];
    if (root === 'yue') {
      return voices.find(v => language(v).startsWith('yue-'))
        || voices.find(v => language(v) === 'zh-hk') || null;
    }
    // Regional spoken Arabic grammar is not interchangeable with MSA voice.
    if (root === 'ar' && target !== 'ar' && target !== 'ar-001') return null;
    return voices.find(v => language(v).split('-')[0] === root) || null;
  }
  speak(text, languageTag, options = {}) {
    if (!this.available()) throw new Error('Browser speech is unavailable.');
    this.stop();
    const voice = this.bestVoice(languageTag, options);
    if (!voice) throw new Error('No compatible enabled speech voice; text preview only.');
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = voice.lang; utterance.voice = voice;
    if (options.onError) utterance.onerror = event => {
      if (!['canceled', 'interrupted'].includes(event.error))
        options.onError(event.error || 'unknown browser synthesis error');
    };
    if (options.onStart) utterance.onstart = options.onStart;
    this.synth.speak(utterance);
    return voice;
  }
  stop() { if (this.available()) this.synth.cancel(); }
}

class FixedAudioProvider {
  constructor() { this.audio = null; }
  available(phrase) { return Boolean(phrase?.audioPath); }
  async play(path) {
    this.stop();
    this.audio = new Audio(path);
    await this.audio.play();
  }
  stop() {
    if (!this.audio) return;
    this.audio.pause();
    this.audio.currentTime = 0;
    this.audio = null;
  }
}

class LocalFeedbackProvider {
  constructor(storage = null) {
    try { this.storage = storage || window.localStorage; } catch (_) { this.storage = null; }
    this.memory = new Map();
    this.key = 'voice-navi-world-lab-feedback-v1';
  }

  read() {
    try {
      const value = JSON.parse(this.memory.get(this.key) || this.storage?.getItem(this.key) || '{}');
      return { favorites: Array.isArray(value.favorites) ? value.favorites : [], reviews: value.reviews || {} };
    } catch (_) {
      return { favorites: [], reviews: {} };
    }
  }

  write(value) {
    const raw = JSON.stringify(value);
    try {
      if (!this.storage) throw new Error('Storage unavailable');
      this.storage.setItem(this.key, raw);
      this.memory.delete(this.key);
    } catch (_) { this.memory.set(this.key, raw); }
  }

  isFavorite(packID) { return this.read().favorites.includes(packID); }

  toggleFavorite(packID) {
    const value = this.read();
    const set = new Set(value.favorites);
    if (set.has(packID)) set.delete(packID); else set.add(packID);
    value.favorites = [...set].sort();
    this.write(value);
    return set.has(packID);
  }

  reviewKey(pack, phrase, modeID = null) { return `${pack.packID}@${pack.version}:${modeID || 'default'}:${phrase.id}`; }

  getReview(pack, phrase, modeID = null) { return this.read().reviews[this.reviewKey(pack, phrase, modeID)] || null; }

  saveReview(pack, phrase, review, modeID = null) {
    const value = this.read();
    value.reviews[this.reviewKey(pack, phrase, modeID)] = review;
    this.write(value);
  }

  clearReview(pack, phrase, modeID = null) {
    const value = this.read();
    delete value.reviews[this.reviewKey(pack, phrase, modeID)];
    this.write(value);
  }
}

const speech = new BrowserSpeechProvider();
const fixedAudio = new FixedAudioProvider();
const feedback = new LocalFeedbackProvider();
const state = { catalog: null, language: null, market: 'ALL', pack: null, mode: null, phrase: null, search: '', favoritesOnly: false };
const $ = id => document.getElementById(id);
function preferredVoice() {
  return speech.bestVoice(state.pack?.languageTag || '',
    { allowRemote: $('allow-remote-voices').checked });
}
function refreshPlaybackButton() {
  $('speak-button').disabled = !state.phrase ||
    (!fixedAudio.available(state.phrase) && !preferredVoice());
}
function updateDeviceVoiceCount() {
  const all = speech.voices();
  const local = all.filter(v => v.localService === true).length;
  const remote = all.filter(v => v.localService === false).length;
  $('device-voice-status').textContent = all.length + ' voices on this browser (' +
    local + ' explicitly on-device, ' + remote + ' remote-reported). ' +
    (all.length ? 'Region accent still needs verification.' : 'Click Recheck when voices are installed.');
}


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

function packModes(pack = state.pack) {
  return Array.isArray(pack?.modes) ? pack.modes : [];
}

function activePhrases() {
  return state.mode?.phrases || state.pack?.phrases || [];
}

function stopAll() {
  speech.stop();
  fixedAudio.stop();
}

function renderMode(preferredPhraseID = state.phrase?.id) {
  const phrases = activePhrases();
  $('phrase-select').replaceChildren(...phrases.map(phrase => option(phrase.id, phrase.label)));
  state.phrase = phrases.find(phrase => phrase.id === preferredPhraseID) || phrases[0] || null;
  if (state.phrase) $('phrase-select').value = state.phrase.id;
  renderPhrase();
  updateVoiceStatus();
}

function deepLinkURL(pack = state.pack, phrase = state.phrase) {
  const url = new URL(window.location.href);
  url.search = '';
  if (pack) url.searchParams.set('pack', pack.packID);
  if (state.mode) url.searchParams.set('mode', state.mode.id);
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
  const modeID = params.get('mode');
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
  if (modeID) {
    const mode = packModes(pack).find(item => item.id === modeID);
    if (mode) { state.mode = mode; $('mode-select').value = mode.id; renderMode(phraseID); }
  }
  if (phraseID) {
    const phrase = activePhrases().find(item => item.id === phraseID);
    if (phrase) { state.phrase = phrase; $('phrase-select').value = phrase.id; renderPhrase(); updateVoiceStatus(); }
  }
  return true;
}

function renderLanguageOptions() {
  const roots = [...new Set(state.catalog.packs.map(pack => pack.languageRoot))].sort();
  $('language-select').replaceChildren(...roots.map(root => option(root, `${languageLabel(root)} (${state.catalog.packs.filter(p => p.languageRoot === root).length})`)));
  const browserRoot = (navigator.language || '').split('-')[0].toLowerCase();
  state.language = roots.includes(browserRoot) ? browserRoot : (roots.includes('ja') ? 'ja' : roots[0]);
  $('language-select').value = state.language;
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
  const previousModeID = preserveSelection ? state.mode?.id : null;
  const previousPhraseID = preserveSelection ? state.phrase?.id : null;
  $('pack-select').replaceChildren(...packs.map(pack => option(pack.packID, pack.displayName)));
  state.pack = packs.find(pack => pack.packID === previousID)
    || packs.find(pack => pack.dialectID === 'standard')
    || packs[0]
    || null;
  $('pack-select').disabled = packs.length === 0;
  if (state.pack) $('pack-select').value = state.pack.packID;
  renderPack();
  if (preserveSelection && state.pack?.packID === previousID && previousModeID) {
    const mode = packModes().find(item => item.id === previousModeID);
    if (mode) { state.mode = mode; $('mode-select').value = mode.id; renderMode(previousPhraseID); }
  }
  if (preserveSelection && state.pack?.packID === previousID && previousPhraseID) {
    const phrase = activePhrases().find(item => item.id === previousPhraseID);
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
  return activePhrases().flatMap(phrase => {
    const review = feedback.getReview(pack, phrase, state.mode?.id);
    return review ? [{ phrase, review }] : [];
  });
}

function updateReviewProgress() {
  const total = activePhrases().length;
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
  const phrases = activePhrases();
  if (!pack || !phrases.length) return null;
  const start = Math.max(0, phrases.findIndex(phrase => phrase.id === state.phrase?.id));
  for (let offset = 1; offset <= phrases.length; offset += 1) {
    const phrase = phrases[(start + offset) % phrases.length];
    if (!feedback.getReview(pack, phrase, state.mode?.id)) return phrase;
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
    modeID: state.mode?.id || null,
    reviewedPhraseCount: reviews.length,
    totalPhraseCount: activePhrases().length,
    browserSpeechPreviewOnly: !Boolean(state.mode),
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

  const review = feedback.getReview(pack, phrase, state.mode?.id);
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
    modeID: state.mode?.id || null,
    phraseID: state.phrase.id,
    phraseText: state.phrase.text,
    nativeSpeaker: $('native-speaker').checked,
    wordingRating: selectedWordingRating(),
    note: $('review-note').value.trim(),
    browserSpeechPreviewOnly: !Boolean(state.mode)
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
    $('mode-control').hidden = true;
    $('mode-select').replaceChildren();
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
  const names = {     STANDARD_ANCHOR: 'REFERENCE', TEXT_FIRST: 'WORDING DRAFT', REGIONAL_DRAFT: 'WORDING DRAFT',
    ACCENT_FIRST: 'ACCENT STUDY', RESEARCH_HOLD: 'RESEARCH HOLD' };
  $('readiness-badge').textContent = names[pack.previewLane] ||
    (pack.packID === 'ja-standard' ? 'REFERENCE' : 'REGIONAL DRAFT');
  $('pack-name').textContent = pack.displayName;
  $('pack-meta').textContent = [pack.languageTag, pack.region, pack.dialectID, pack.previewLane ? 'Lane: ' + pack.previewLane.replaceAll('_', ' ') : null, 'Browser Voice ≠ verified regional accent'].filter(Boolean).join(' · ');
  $('pack-version').textContent = `v${pack.version}`;
  $('public-language').textContent = languageLabel(pack.languageRoot);
  $('public-style').textContent = titleCase(pack.dialectID || 'standard');
  updateFavoriteButton();

  const modes = packModes(pack);
  state.mode = modes[0] || null;
  $('mode-control').hidden = modes.length < 2;
  $('mode-select').replaceChildren(...modes.map(mode => option(mode.id, mode.label)));
  $('mode-select').disabled = modes.length < 2;
  if (state.mode) $('mode-select').value = state.mode.id;
  renderMode();
}

function renderPhrase() {
  $('phrase-text').textContent = state.phrase?.text || 'No preview phrase available.';
  refreshPlaybackButton();
  $('speak-button').textContent = fixedAudio.available(state.phrase) ? '▶ Play VOICE NAVI voice' : '▶ Preview browser voice';
  loadReviewForm();
}

function updateVoiceStatus(voice = null) {
  updateDeviceVoiceCount();
  if (!state.pack) { $('voice-status').textContent = 'Select a regional phrase.'; return; }
  if (!speech.available()) { $('voice-status').textContent = 'Browser speech unavailable. Text only.'; return; }
  if (fixedAudio.available(state.phrase)) {
    $('voice-status').textContent = 'Fixed candidate audio. Release and accent identity NOT verified.';
    return;
  }
  const selected = voice || preferredVoice();
  const locale = state.pack.languageTag;
  if (!selected) {
    const remote = speech.bestVoice(locale, {allowRemote:true});
    const dialectArabic = locale.toLowerCase().startsWith('ar-') &&
      locale.toLowerCase() !== 'ar-001';
    $('voice-status').textContent = dialectArabic
      ? 'No suitable spoken Arabic dialect voice for ' + locale +
        '. Formal Arabic is not automatically substituted; text-only.'
      : remote && remote.localService === false && !$('allow-remote-voices').checked
      ? 'Only remote browser speech is available. Check the network opt-in above if acceptable.'
      : 'No compatible enabled browser voice for ' + locale + '. Text-only preview.';
    return;
  }
  const requested = locale.toLowerCase().replaceAll('_','-');
  const actual = selected.lang.toLowerCase().replaceAll('_','-');
  const exact = requested === actual || (requested === 'yue-hk' && actual === 'zh-hk');
  const where = selected.localService === true ? 'On-device synthesis.'
    : selected.localService === false ? 'Remote synthesis may use network.'
    : 'Synthesis location unknown.';
  const lane = state.pack.previewLane;
  const caution = lane === 'RESEARCH_HOLD'
    ? 'Research hold: insufficient regional evidence.'
    : lane === 'ACCENT_FIRST' ? 'Regional accent is NOT provided by the standard browser voice.'
    : lane === 'TEXT_FIRST' ? 'Regional word choices are not native-reviewed.'
    : 'Accent identity not verified.';
  $('voice-status').textContent = selected.name + ' (' + selected.lang + '). ' +
    (exact ? 'Language tag match.' : 'Approximate language fallback.') +
    ' ' + caution + ' Local and Deep Local use the same system voice. ' + where;
}

async function loadCatalog() {
  const response = await fetch('data/catalog.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Catalog request failed: ${response.status}`);
  state.catalog = await response.json();
  $('pack-count').textContent = String(state.catalog.packCount);
  $('language-count').textContent = String(new Set(state.catalog.packs.map(p => p.languageRoot)).size);
  renderLanguageOptions(); renderMarketOptions(); renderPackOptions();
  if (!applyDeepLink()) syncURL();
  if (new URLSearchParams(window.location.search).get('review') === '1') {
    requestAnimationFrame(() => $('feedback-title').scrollIntoView({ block: 'start' }));
  }
}

$('language-select').addEventListener('change', event => {
  stopAll(); state.language = event.target.value; state.search = ''; $('pack-search').value = '';
  renderMarketOptions(); renderPackOptions(); syncURL();
});
$('market-select').addEventListener('change', event => {
  stopAll(); state.market = event.target.value; renderPackOptions(); syncURL();
});
$('pack-search').addEventListener('input', event => {
  stopAll(); state.search = event.target.value; renderPackOptions({ preserveSelection: true }); syncURL();
});
$('pack-select').addEventListener('change', event => {
  stopAll(); state.pack = state.catalog.packs.find(pack => pack.packID === event.target.value) || null; renderPack(); syncURL();
});
$('mode-select').addEventListener('change', event => {
  stopAll();
  const preferredPhraseID = state.phrase?.id;
  state.mode = packModes().find(mode => mode.id === event.target.value) || null;
  renderMode(preferredPhraseID);
  syncURL();
});
$('phrase-select').addEventListener('change', event => {
  stopAll(); state.phrase = activePhrases().find(phrase => phrase.id === event.target.value) || null; renderPhrase(); updateVoiceStatus(); syncURL();
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
  }, state.mode?.id);
  updateReviewProgress();
  $('feedback-status').textContent = 'Saved locally on this device. Nothing was uploaded.';
});
$('clear-review-button').addEventListener('click', () => {
  if (!state.pack || !state.phrase) return;
  feedback.clearReview(state.pack, state.phrase, state.mode?.id);
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
$('speak-button').addEventListener('click', async () => {
  try {
    if (fixedAudio.available(state.phrase)) {
      speech.stop();
      await fixedAudio.play(state.phrase.audioPath);
      updateVoiceStatus();
    } else {
      fixedAudio.stop();
      const chosen = speech.speak(state.phrase.text, state.pack.languageTag, {
        allowRemote: $('allow-remote-voices').checked,
        onStart: () => updateVoiceStatus(),
        onError: reason => { $('voice-status').textContent =
          'Browser audio failed: ' + reason + '. Text remains available.'; }
      });
      updateVoiceStatus(chosen);
    }
  } catch (error) { $('voice-status').textContent = error.message; }
});
$('stop-button').addEventListener('click', () => stopAll());
if (speech.available()) speech.synth.addEventListener?.('voiceschanged', () => {
  refreshPlaybackButton(); updateVoiceStatus();
});
$('allow-remote-voices').addEventListener('change', () => {
  speech.stop(); refreshPlaybackButton(); updateVoiceStatus();
});
$('rescan-voices-button').addEventListener('click', () => {
  refreshPlaybackButton(); updateVoiceStatus();
});
$('copy-voice-report-button').addEventListener('click', async () => {
  const report = {
    kind:'voice-navi-free-beta-browser-voice-inventory',
    packID:state.pack?.packID || null,
    regionVoiceStatus:state.pack?.previewLane || null,
    remoteOptIn:$('allow-remote-voices').checked,
    voices:speech.voices().map(v => ({
      name:v.name, languageTag:v.lang,
      location:v.localService === true ? 'local' :
        v.localService === false ? 'remote' : 'unknown'
    }))
  };
  try {
    await copyText(JSON.stringify(report,null,2));
    $('copy-voice-status').textContent = 'Report copied locally. Nothing uploaded.';
  } catch (_) {
    $('copy-voice-status').textContent = 'Copy unavailable. No data uploaded.';
  }
});

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

// No service-worker registration in the non-deployable editorial staging preview.
loadCatalog().catch(error => {
  $('pack-name').textContent = 'Catalog unavailable'; $('pack-meta').textContent = error.message; $('speak-button').disabled = true;
});
