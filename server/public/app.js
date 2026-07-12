const GOODS = {
  0: 'Water', 1: 'Furs', 2: 'Food', 3: 'Ore', 4: 'Games',
  5: 'Firearms', 6: 'Medicine', 7: 'Machines', 8: 'Narcotics', 9: 'Robots',
};

const SYSTEMS = [
  { id: 'sol', name: 'Sol' },
  { id: 'regulas', name: 'Regulas' },
];

const state = {
  captainId: null,
  captain: null,
  market: [],
  encounterId: null,
  encounter: null,
  policeEncounter: null,
  travelling: false,
  wreckSighted: null,
};

const $ = (id) => document.getElementById(id);

function opId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({ ok: false, error: res.statusText }));
  if (!res.ok || data.ok === false) {
    const msg = data.error || data.code || `HTTP ${res.status}`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return data;
}

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2800);
}

function showTab(name) {
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === name);
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.classList.toggle('hidden', panel.id !== `tab-${name}`);
  });
}

function unitPrice(m) {
  const stockRatio = Math.max(-1, Math.min(1, (m.targetStock - m.stock) / Math.max(1, m.targetStock)));
  const stockAdj = Math.round(stockRatio * 2500);
  const combined = Math.max(-4000, Math.min(4000, stockAdj + (m.pressureBps || 0)));
  return Math.max(1, Math.round((m.equilibriumPrice * (10000 + combined)) / 10000));
}

function renderStatus() {
  const c = state.captain;
  if (!c) return;
  $('status-bar').innerHTML = `
    <div><span>Captain</span><br><strong>${c.handle}</strong></div>
    <div><span>System</span><br><strong>${c.systemId}</strong></div>
    <div><span>Credits</span><br><strong>${c.credits}</strong></div>
    <div><span>Status</span><br><strong>${c.lifecycleState || c.status}</strong></div>
  `;
}

function renderDock() {
  const c = state.captain;
  $('dock-summary').textContent = `${c.handle} docked at ${c.systemId}. Ship: ${c.shipType}. Fuel ${c.fuel}/${c.fuelTanks ?? '?'}. Hull ${c.hull}/${c.maxHull}.`;
  const cargo = c.cargo || [];
  $('cargo-list').innerHTML = cargo.length
    ? cargo.map((lot) => `<li>${GOODS[lot.good] || lot.good} × ${lot.qty}</li>`).join('')
    : '<li class="lede">Hold empty.</li>';
}

function renderMarket() {
  const root = $('market-rows');
  root.innerHTML = state.market.map((m) => {
    const price = unitPrice(m);
    const name = GOODS[m.good] ?? `Good ${m.good}`;
    return `
      <div class="market-row">
        <div>
          <strong>${name}</strong>
          <div class="meta">${price} cr · stock ${m.stock} · pressure ${m.pressureBps} bps</div>
        </div>
        <div class="row-actions">
          <button type="button" data-buy="${m.good}" ${m.stock < 1 ? 'disabled' : ''}>Buy 1</button>
          <button type="button" data-sell="${m.good}">Sell 1</button>
        </div>
      </div>`;
  }).join('') || '<p class="lede">No goods listed.</p>';

  root.querySelectorAll('[data-buy]').forEach((btn) => {
    btn.addEventListener('click', () => trade(+btn.dataset.buy, 'buy'));
  });
  root.querySelectorAll('[data-sell]').forEach((btn) => {
    btn.addEventListener('click', () => trade(+btn.dataset.sell, 'sell'));
  });
}

function renderTravel() {
  const c = state.captain;
  const dest = $('destinations');
  dest.innerHTML = SYSTEMS.filter((s) => s.id !== c.systemId).map((s) => `
    <button type="button" class="primary" data-dest="${s.id}">Jump to ${s.name}</button>
  `).join('') || '<p class="lede">No destinations in range.</p>';

  dest.querySelectorAll('[data-dest]').forEach((btn) => {
    btn.addEventListener('click', () => startTravel(btn.dataset.dest));
  });

  const prog = $('travel-progress');
  if ((c.lifecycleState || c.status) === 'TRAVELLING') {
    const sight = state.wreckSighted;
    const sightHtml = sight
      ? `<p class="lede">Debris on sensors: <strong>${sight.wreckId}</strong>${
          sight.hasEscapePod && sight.podState === 'AVAILABLE'
            ? ` — escape pod available. <button type="button" class="secondary" id="btn-rescue-sighted">Rescue</button>`
            : ''
        }</p>`
      : '';
    prog.innerHTML = `
      <p class="lede">Approach tick ${c.approachTick}. Keep advancing until docked. Ambient NPCs share this space.</p>
      ${sightHtml}
      <button type="button" class="primary" id="btn-advance">Advance approach</button>
      <button type="button" class="secondary" id="btn-traffic">Scan for traffic</button>
      <button type="button" class="secondary" id="btn-wrecks">Scan for wrecks</button>
    `;
    $('btn-advance').onclick = () => advanceTravel();
    $('btn-traffic').onclick = () => scanTraffic();
    $('btn-wrecks').onclick = () => scanWrecks();
    const rescueBtn = $('btn-rescue-sighted');
    if (rescueBtn) rescueBtn.onclick = () => rescueWreck(sight.wreckId);
  } else {
    prog.innerHTML = `
      <button type="button" class="secondary" id="btn-wrecks">Scan for wrecks</button>
    `;
    $('btn-wrecks').onclick = () => scanWrecks();
  }
}

function renderShip() {
  const c = state.captain;
  $('ship-stats').innerHTML = `
    <div><dt>Ship</dt><dd>${c.shipType}</dd></div>
    <div><dt>Hull</dt><dd>${c.hull ?? '—'} / ${c.maxHull ?? '—'}</dd></div>
    <div><dt>Fuel</dt><dd>${c.fuel} / ${c.fuelTanks ?? '—'}</dd></div>
    <div><dt>Police</dt><dd>${c.policeRecord}</dd></div>
    <div><dt>Bounty</dt><dd>${c.activeBounty}</dd></div>
    <div><dt>Disposition</dt><dd>${c.publicDisposition}</dd></div>
    <div><dt>Escape pod</dt><dd>${c.hasEscapePod ? 'yes' : 'no'}</dd></div>
  `;
}

function renderAll() {
  renderStatus();
  renderDock();
  renderMarket();
  renderTravel();
  renderShip();
  if (state.encounter) renderEncounter();
  if (state.policeEncounter) renderPoliceEncounter();
}

// Every captain-mutation response already carries a fresh `captain` view
// (see captainMutationResponse server-side) — applying it directly avoids
// a redundant GET round-trip that otherwise leaves the UI showing stale
// credits/status for the gap between the toast and that extra fetch.
async function applyCaptainUpdate(captain) {
  state.captain = captain;
  if (captain.activePoliceEncounterId) {
    state.policeEncounter = {
      id: captain.activePoliceEncounterId,
      contact: captain.policeContact,
      phase: captain.policePhase,
    };
    state.encounterId = null;
    state.encounter = null;
    $('encounter').classList.add('hidden');
    renderPoliceEncounter();
  } else if (captain.activeEncounterId) {
    state.policeEncounter = null;
    $('police-encounter').classList.add('hidden');
    state.encounterId = captain.activeEncounterId;
    await refreshEncounter();
  } else {
    state.policeEncounter = null;
    $('police-encounter').classList.add('hidden');
    state.encounterId = null;
    state.encounter = null;
    $('encounter').classList.add('hidden');
  }
}

async function refreshCaptain() {
  const data = await api(`/captains/${state.captainId}`);
  await applyCaptainUpdate(data.captain);
}

/** Mirrors legalPoliceResponses in ruleset-phase0-v1 (plain JS; no bundler). */
function legalPoliceResponses(contact, phase) {
  if (phase === 'COMBAT') {
    if (contact === 'ATTACK_ON_SIGHT') return ['FLEE', 'ATTACK'];
    return ['ATTACK', 'FLEE', 'SURRENDER'];
  }
  if (phase === 'CONTACT') {
    if (contact === 'INSPECTION') return ['COMPLY', 'FLEE', 'ATTACK'];
    if (contact === 'SURRENDER_ORDER') return ['SURRENDER', 'FLEE', 'ATTACK'];
    if (contact === 'ATTACK_ON_SIGHT') return ['FLEE', 'ATTACK'];
  }
  return [];
}

function renderPoliceEncounter() {
  const pe = state.policeEncounter;
  if (!pe) {
    $('police-encounter').classList.add('hidden');
    return;
  }
  $('police-encounter').classList.remove('hidden');
  const contactLabel = (pe.contact || 'UNKNOWN').replace(/_/g, ' ');
  $('police-encounter-meta').textContent =
    `Routine ${contactLabel} — ${pe.phase === 'COMBAT' ? 'combat!' : 'comply, flee, or fight?'}`;
  const responses = legalPoliceResponses(pe.contact, pe.phase);
  const root = $('police-encounter-actions');
  root.innerHTML = responses.length
    ? responses.map((r) => `<button type="button" data-police="${r}">${r}</button>`).join('')
    : '<p class="lede">No responses available.</p>';
  root.querySelectorAll('[data-police]').forEach((btn) => {
    btn.addEventListener('click', () => submitPoliceResponse(btn.dataset.police));
  });
}

async function submitPoliceResponse(response) {
  try {
    const data = await api(`/captains/${state.captainId}/police/respond`, {
      method: 'POST',
      body: JSON.stringify({ operationId: opId('police'), response }),
    });
    const result = data.result || {};
    let msg = `Police: ${result.endReason || result.phaseAfter || response}`;
    if (result.fine > 0) msg += ` · fine ${result.fine}`;
    if (result.confiscated?.length) {
      msg += ` · confiscated ${result.confiscated.map((l) => `${GOODS[l.good] || l.good}×${l.qty}`).join(', ')}`;
    }
    if (result.fleeSuccess) msg += ' · fled';
    await applyCaptainUpdate(data.captain);
    renderAll();
    toast(msg);
    $('police-encounter-status').textContent = msg;
    await refreshMarket();
    renderMarket();
  } catch (err) {
    toast(err.message);
  }
}

async function refreshMarket() {
  const systemId = state.captain.systemId;
  const data = await api(`/systems/${systemId}/market`);
  state.market = data.market || [];
}

async function trade(good, side) {
  try {
    const data = await api(`/captains/${state.captainId}/trade`, {
      method: 'POST',
      body: JSON.stringify({
        operationId: opId('trade'),
        good,
        side,
        quantity: 1,
      }),
    });
    await applyCaptainUpdate(data.captain);
    renderAll();
    toast(`${side === 'buy' ? 'Bought' : 'Sold'} ${GOODS[good] || good}`);
    await refreshMarket();
    renderMarket();
  } catch (err) {
    toast(err.message);
  }
}

async function startTravel(destinationSystemId) {
  try {
    const data = await api(`/captains/${state.captainId}/travel/start`, {
      method: 'POST',
      body: JSON.stringify({
        operationId: opId('trip'),
        destinationSystemId,
        seed: Math.floor(Math.random() * 1e9) + 1,
      }),
    });
    await applyCaptainUpdate(data.captain);
    renderAll();
    showTab('travel');
    toast(`Hyperspace to ${destinationSystemId}`);
  } catch (err) {
    toast(err.message);
  }
}

async function advanceTravel() {
  try {
    const data = await api(`/captains/${state.captainId}/travel/advance`, {
      method: 'POST',
      body: JSON.stringify({ operationId: opId('adv') }),
    });
    const result = data.result || {};
    state.wreckSighted = result.wreckSighted || null;
    if (result.docked) state.wreckSighted = null;
    await applyCaptainUpdate(data.captain);
    renderAll();
    if (result.wreckSighted) {
      toast(`Debris sighted: ${result.wreckSighted.wreckId}`);
    } else {
      toast(result.docked ? `Docked at ${result.systemId}` : `Approach ${result.approachTick}`);
    }
    if (!result.docked && result.routeArea != null && result.globalTick != null) {
      await tryMatch(state.captain.systemId, result.routeArea, result.globalTick);
      renderAll();
    }
    if (result.docked) {
      await refreshMarket();
      renderMarket();
    }
  } catch (err) {
    toast(err.message);
  }
}

async function scanTraffic() {
  try {
    // Nudge ambient NPCs then match the current travel window.
    try {
      await api('/admin/ambient-tick', { method: 'POST', body: '{}' });
    } catch {
      /* ambient admin may be disabled; matching still works if NPCs are present */
    }
    const c = state.captain;
    const routeArea = c.systemId + ':approach';
    const tick = Math.floor(Date.now() / 5000);
    await tryMatch(c.systemId, routeArea, tick);
    if (!state.encounterId) toast('No traffic this window');
  } catch (err) {
    toast(err.message);
  }
}

async function scanWrecks() {
  try {
    const systemId = state.captain.systemId;
    const data = await api(`/systems/${systemId}/wrecks`);
    const wrecks = data.wrecks || [];
    const root = $('wreck-list');
    if (!wrecks.length) {
      root.innerHTML = '<p class="lede">No wrecks on sensors.</p>';
      toast('No wrecks in system');
      return;
    }
    root.innerHTML = wrecks.map((w) => {
      const cargoBits = (w.cargo || []).map((l) => `${GOODS[l.good] || l.good}×${l.qty}`).join(', ') || 'empty hold';
      const pod = w.podState === 'AVAILABLE'
        ? `<button type="button" data-rescue="${w.wreckId}">Rescue</button>`
        : `<span class="meta">${w.escapePodCaptainId ? `pod ${w.podState}` : 'debris only'}</span>`;
      return `
        <div class="wreck-row">
          <div>
            <strong>${w.wreckId}</strong>
            <div class="meta">${cargoBits}</div>
          </div>
          <div class="row-actions">${pod}</div>
        </div>`;
    }).join('');
    root.querySelectorAll('[data-rescue]').forEach((btn) => {
      btn.addEventListener('click', () => rescueWreck(btn.dataset.rescue));
    });
    toast(`Found ${wrecks.length} wreck(s)`);
  } catch (err) {
    toast(err.message);
  }
}

async function rescueWreck(wreckId) {
  try {
    const data = await api(`/systems/${state.captain.systemId}/wrecks/rescue`, {
      method: 'POST',
      body: JSON.stringify({ wreckId, rescuerId: state.captainId }),
    });
    if (state.wreckSighted?.wreckId === wreckId) state.wreckSighted = null;
    await scanWrecks();
    await refreshCaptain();
    await refreshMarket();
    renderAll();
    toast(`Rescued ${data.rescuedCaptainId || 'captain'}`);
  } catch (err) {
    toast(err.message);
  }
}

async function tryMatch(systemId, routeArea, globalTick) {
  try {
    const data = await api(`/systems/${systemId}/match`, {
      method: 'POST',
      body: JSON.stringify({ routeArea, globalTick }),
    });
    const hit = (data.claimed || []).find((c) => c.ok && c.encounterId);
    if (hit) {
      state.encounterId = hit.encounterId;
      await refreshEncounter();
      toast('Captain on sensors');
    }
  } catch {
    /* matching is best-effort */
  }
}

async function refreshEncounter() {
  if (!state.encounterId) return;
  const data = await api(`/encounters/${state.encounterId}/view?captainId=${encodeURIComponent(state.captainId)}`);
  state.encounter = data.view;
  if (data.view?.phase === 'COMPLETE' || data.lifecycle === 'COMPLETE' || data.lifecycle === 'SETTLING') {
    toast('Encounter resolved');
    state.encounterId = null;
    state.encounter = null;
    $('encounter').classList.add('hidden');
    await refreshCaptain();
    await refreshMarket();
    renderAll();
    return;
  }
  $('encounter').classList.remove('hidden');
  renderEncounter();
}

function renderEncounter() {
  const v = state.encounter;
  if (!v) return;
  if (v.phase === 'COMPLETE') {
    state.encounterId = null;
    state.encounter = null;
    $('encounter').classList.add('hidden');
    return;
  }
  $('encounter').classList.remove('hidden');
  $('encounter-meta').textContent = `Phase ${v.phase} · round ${v.roundNo}`;
  $('encounter-opp').innerHTML = `
    <strong>${v.opponent.handle}</strong>
    <div class="meta">Hull ${v.opponent.hull} · ${v.opponent.publicDisposition} · police ${v.opponent.policeRecord}</div>
  `;
  const phase = v.phase;
  const actions = phase === 'COMBAT'
    ? ['ATTACK', 'FLEE', 'SURRENDER']
    : phase === 'SURRENDER_RESOLUTION'
      ? ['SURRENDER_CLAIM']
      : ['ATTACK', 'FLEE', 'HAIL', 'IGNORE', 'DEMAND', 'TRADE_OFFER'];

  const root = $('encounter-actions');
  if (v.you.hasLockedAction) {
    root.innerHTML = '<p class="lede">Action locked — waiting for resolution.</p>';
  } else {
    root.innerHTML = actions.map((type) => `
      <button type="button" data-act="${type}">${type.replace('_', ' ')}</button>
    `).join('');
    root.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => submitEncounterAction(btn.dataset.act));
    });
  }
}

async function submitEncounterAction(type) {
  try {
    const action = {
      actionId: opId('act'),
      roundNo: state.encounter.roundNo,
      type,
    };
    if (type === 'DEMAND') {
      action.demand = { credits: 50, cargo: [] };
    }
    if (type === 'TRADE_OFFER') {
      action.tradeOffer = {
        aToB: { credits: 0, cargo: [{ good: 0, qty: 1 }] },
        bToA: { credits: 40, cargo: [] },
      };
    }
    if (type === 'SURRENDER_CLAIM') {
      action.surrenderClaim = { credits: 0, cargo: [] };
    }
    const data = await api(`/encounters/${state.encounterId}/action`, {
      method: 'POST',
      body: JSON.stringify({ captainId: state.captainId, action }),
    });
    $('encounter-status').textContent = `Lifecycle: ${data.lifecycle || state.encounter.phase}`;
    if (data.lifecycle === 'SETTLING' || data.lifecycle === 'COMPLETE') {
      state.encounterId = null;
      state.encounter = null;
      $('encounter').classList.add('hidden');
      await refreshCaptain();
      await refreshMarket();
      renderAll();
      toast('Encounter resolved');
      return;
    }
    await refreshEncounter();
    await refreshCaptain();
    renderAll();
  } catch (err) {
    toast(err.message);
  }
}

async function enterGame() {
  $('auth').classList.add('hidden');
  $('boot').classList.remove('hidden');
  try {
    await refreshCaptain();
    await refreshMarket();
    $('boot').classList.add('hidden');
    $('game').classList.remove('hidden');
    renderAll();
    toast('Welcome aboard');
  } catch {
    // Galaxy may not be initialized yet — show boot panel.
  }
}

async function boot() {
  const status = $('boot-status');
  status.textContent = 'Bootstrapping…';
  try {
    await api('/admin/bootstrap', { method: 'POST', body: '{}' });
    await refreshCaptain();
    await refreshMarket();
    $('boot').classList.add('hidden');
    $('game').classList.remove('hidden');
    renderAll();
    toast('Galaxy online');
  } catch (err) {
    status.textContent = err.message;
  }
}

$('btn-request-link').addEventListener('click', async () => {
  try {
    const email = $('auth-email').value;
    const data = await api('/auth/request-link', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
    if (data.magicLinkToken) {
      $('auth-token').value = data.magicLinkToken;
      $('auth-status').textContent = 'Dev token filled — click Verify.';
    } else {
      $('auth-status').textContent = data.message || 'Check your email.';
    }
  } catch (err) {
    $('auth-status').textContent = err.message;
  }
});

$('btn-verify').addEventListener('click', async () => {
  try {
    const token = $('auth-token').value.trim();
    const data = await api('/auth/verify', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
    state.captainId = data.captainId;
    await enterGame();
  } catch (err) {
    $('auth-status').textContent = err.message;
  }
});

$('btn-boot').addEventListener('click', boot);

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => showTab(btn.dataset.tab));
});

$('btn-refuel').addEventListener('click', async () => {
  try {
    const data = await api(`/captains/${state.captainId}/dock/refuel`, {
      method: 'POST',
      body: JSON.stringify({ operationId: opId('fuel') }),
    });
    await applyCaptainUpdate(data.captain);
    renderAll();
    toast('Tanks topped up');
  } catch (err) {
    toast(err.message);
  }
});

$('btn-repair').addEventListener('click', async () => {
  try {
    const data = await api(`/captains/${state.captainId}/dock/repair`, {
      method: 'POST',
      body: JSON.stringify({ operationId: opId('repair') }),
    });
    await applyCaptainUpdate(data.captain);
    renderAll();
    toast('Hull repaired');
  } catch (err) {
    toast(err.message);
  }
});

$('btn-upgrade').addEventListener('click', async () => {
  try {
    const data = await api(`/captains/${state.captainId}/dock/upgrade`, {
      method: 'POST',
      body: JSON.stringify({ operationId: opId('upgrade'), shipTypeId: 2, systemTechLevel: 5 }),
    });
    await applyCaptainUpdate(data.captain);
    renderAll();
    toast('Ship upgraded');
  } catch (err) {
    toast(err.message);
  }
});

$('btn-escape-pod').addEventListener('click', async () => {
  try {
    const data = await api(`/captains/${state.captainId}/equipment/escape-pod`, {
      method: 'POST',
      body: JSON.stringify({ operationId: opId('pod') }),
    });
    await applyCaptainUpdate(data.captain);
    renderAll();
    toast('Escape pod installed');
  } catch (err) {
    toast(err.message);
  }
});

$('btn-retire').addEventListener('click', async () => {
  if (!confirm('Retire this captain permanently?')) return;
  try {
    const previousId = state.captainId;
    await api(`/captains/${state.captainId}/retire`, {
      method: 'POST',
      body: JSON.stringify({ operationId: opId('retire') }),
    });
    const me = await api('/auth/me');
    if (me.captainId && me.captainId !== previousId) {
      state.captainId = me.captainId;
      toast('Captain retired — starting a new captain');
      await enterGame();
      return;
    }
    toast('Captain retired');
    await refreshCaptain();
    renderAll();
  } catch (err) {
    toast(err.message);
  }
});

$('btn-logout').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST', body: '{}' });
  location.reload();
});

document.addEventListener('visibilitychange', async () => {
  if (!state.encounterId || !state.captainId) return;
  try {
    if (document.hidden) {
      await api(`/encounters/${state.encounterId}/disconnect`, {
        method: 'POST',
        body: JSON.stringify({ captainId: state.captainId }),
      });
    } else {
      const data = await api(`/encounters/${state.encounterId}/reconnect`, {
        method: 'POST',
        body: JSON.stringify({ captainId: state.captainId }),
      });
      if (data.summary) {
        toast(`Proxy ran ${data.summary.proxyControlledRounds?.length || 0} round(s)`);
      }
      await refreshEncounter();
    }
  } catch {
    /* ignore */
  }
});

// Resume session if cookie present
(async () => {
  try {
    const me = await api('/auth/me');
    if (me.captainId) {
      state.captainId = me.captainId;
      await enterGame();
    }
  } catch {
    /* show auth panel */
  }
})();
