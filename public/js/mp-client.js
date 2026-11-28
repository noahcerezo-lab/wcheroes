/*
 * West Coast Heroes — multiplayer client (lobby, session, input, prediction).
 *
 * - Session: the server gives each player a secret token, stored in localStorage. After a drop or a
 *   page refresh we send `session:resume` and get the same hero back (within the server's grace window).
 * - Prediction: every 50 ms we send one numbered input and immediately apply the same movement rule
 *   locally (WCHSim.stepHero), so your hero moves with no network delay. Each snapshot tells us the last
 *   input the server applied (hero.seq); we restart from the server's position and replay newer inputs.
 *   Other heroes are drawn with interpolation (mp-arena.js).
 */
(function () {
    'use strict';
    const SIM = window.WCHSim, ROSTER = WCHHeroes.HEROES, STORE_KEY = 'wch.session';
    const params = new URLSearchParams(location.search);
    const socket = io({ reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 500, reconnectionDelayMax: 5000, timeout: 20000 });
    const $ = id => document.getElementById(id);
    let room = null, world = null, me = null; // me = {playerId, token, code}
    let seq = 0, pending = [], predicted = null, predictedFor = null, visualOffset = { x: 0, y: 0 }, lastLocalMove = 0;
    const keys = {}, touch = { x: 0, y: 0, attack: false, special: false };
    const tapped = { attack: false, special: false }; // a quick tap between two input ticks still counts
    const predictionOn = params.get('predict') !== '0';
    const keepArt = params.get('newart') === '1' ? '&newart=1' : ''; // keep the art preview flag in room URLs

    if (window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0) document.body.classList.add('touch');

    // ---------- small UI helpers ----------
    function show(id) {
        for (const key of ['entry', 'lobby', 'battle']) $(key).classList.toggle('hidden', key !== id);
        document.body.classList.toggle('in-battle', id === 'battle');
        if (id === 'battle') $('notice').textContent = ''; else { renderEvolution(null); renderFusion(null); renderField(null); renderVirtues(null); }
    }
    function note(msg, ms = 6500) {
        $('notice').textContent = msg;
        setTimeout(() => { if ($('notice').textContent === msg) $('notice').textContent = '' }, ms);
    }
    function send(event, data, cb) {
        socket.emit(event, data, r => {
            if (!r?.ok) { note(r?.error || 'Request failed'); return }
            cb?.(r);
        });
    }
    const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const invite = () => location.origin + location.pathname + '?room=' + room.code + keepArt;
    const myId = () => me?.playerId || null;

    // ---------- session ----------
    function saveSession(r) {
        me = { playerId: r.playerId, token: r.token, code: r.code };
        try { localStorage.setItem(STORE_KEY, JSON.stringify(me)) } catch {}
        history.replaceState({}, '', '?room=' + r.code + keepArt);
    }
    function clearSession() {
        me = null;
        try { localStorage.removeItem(STORE_KEY) } catch {}
    }
    function storedSession() {
        try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null') } catch { return null }
    }
    function resume() {
        const s = me || storedSession();
        if (!s?.token) return;
        socket.emit('session:resume', { token: s.token }, r => {
            if (!r?.ok) {
                clearSession();
                $('conn').classList.add('hidden');
                room = null; world = null; arena.reset(); resetPrediction();
                show('entry');
                if (s.code) $('roomCode').value = s.code;
                note('Your previous session expired — join again.');
                return;
            }
            saveSession(r);
            seq = Math.max(seq, r.lastSeq || 0);
            if (r.phase === 'battle' && r.world) { world = r.world; arena.reset(); arena.push(r.world); resetPrediction(); show('battle') } // prediction restarts on the next snapshot (controller is set by the next tick)
            $('conn').classList.add('hidden');
            note(r.phase === 'battle' ? 'Reconnected — you have your hero back.' : 'Reconnected to room ' + r.code + '.');
        });
    }

    // ---------- lobby ----------
    function renderLobby() {
        if (!room) return;
        $('code').textContent = room.code;
        const mine = room.players.find(p => p.id === myId());
        $('heroes').replaceChildren();
        room.slots.forEach((slot, i) => {
            const owner = room.players.find(p => p.hero === i), b = document.createElement('button');
            const cfg = ROSTER[i];
            b.className = 'hero' + (mine?.hero === i ? ' mine' : '') + (owner && owner.id !== myId() ? ' taken' : '');
            b.disabled = !!owner && owner.id !== myId();
            b.style.setProperty('--hero', cfg.color);
            const bars = WCHHeroes.STAT_KEYS.map(k => '<span class="stat"><i>' + k + '</i><span class="bar"><span style="width:' + Math.round(cfg.fill[k] * 100) + '%"></span></span></span>').join('');
            const tag = !owner ? 'AVAILABLE' : !owner.connected ? '⟳ ' + esc(owner.name) + ' reconnecting…' : esc(owner.name) + (owner.ready ? ' ✓ READY' : ' • NOT READY');
            b.innerHTML = '<span class="slot">' + cfg.slot + '</span>' + '<img class="portrait" src="assets/portraits/' + slot.hero.toLowerCase() + '.png" alt="' + slot.hero + ' portrait">' + '<b>' + slot.hero + '</b><small>' + cfg.cls + '</small><span class="stats">' + bars + '</span><span class="tag">' + tag + '</span>';
            b.onclick = () => send('hero:select', { hero: i });
            $('heroes').appendChild(b);
        });
        const connected = room.players.filter(p => p.connected), waiting = room.players.filter(p => !p.connected);
        $('ready').textContent = mine?.ready ? '✓ READY — TAP TO UNREADY' : "I'M READY";
        $('start').classList.toggle('hidden', room.host !== myId());
        $('start').disabled = !connected.length || connected.some(p => !p.ready);
        $('lobbyStatus').textContent = connected.length + ' player(s) connected • ' + (4 - connected.length) + ' AI teammate(s) • ' + connected.filter(p => p.ready).length + '/' + connected.length + ' ready' + (waiting.length ? ' • waiting on ' + waiting.map(p => p.name).join(', ') : '') + (room.host === myId() ? ' • you are the host' : '');
    }
    function renderSquad() {
        if (!room) return;
        $('toLobby').classList.toggle('hidden', room.host !== myId());
        const active = room.activeRoster || [0, 1, 2, 3];
        $('squad').replaceChildren(...active.map(i => { const slot = room.slots[i];
            const owner = room.players.find(p => p.hero === i), li = document.createElement('li');
            li.style.setProperty('--hero', ROSTER[i].color);
            li.className = owner?.connected ? '' : 'ai';
            let who;
            if (!owner) who = '<span class="badge ai">AI</span>';
            else if (!owner.connected) who = esc(owner.name) + ' <span class="badge wait">reconnecting ' + Math.ceil(owner.graceLeftMs / 1000) + 's</span> <span class="badge ai">AI meanwhile</span>';
            else who = esc(owner.name) + (owner.id === myId() ? ' <span class="badge you">YOU</span>' : '') + (owner.id === room.host ? ' <span class="badge">HOST</span>' : '');
            li.innerHTML = '<b>' + ROSTER[i].slot + ' ' + slot.hero + '</b>' + who;
            return li;
        }));
    }
    function render() {
        if (!room) return;
        renderLobby();
        renderSquad();
        show(room.phase === 'battle' ? 'battle' : 'lobby');
    }

    $('create').onclick = () => send('room:create', { name: $('name').value }, r => { saveSession(r); seq = 0 });
    $('join').onclick = () => send('room:join', { code: $('roomCode').value, name: $('name').value }, r => { saveSession(r); seq = 0 });
    $('ready').onclick = () => { const mine = room?.players.find(p => p.id === myId()); send('player:ready', { ready: !mine?.ready }) };
    $('start').onclick = () => send('room:start', {});
    $('toLobby').onclick = () => send('room:lobby', {});
    const leave = () => { resetJoy(); socket.emit('room:leave'); clearSession(); room = null; world = null; arena.reset(); resetPrediction(); history.replaceState({}, '', location.pathname + (keepArt ? '?newart=1' : '')); show('entry') };
    $('leaveLobby').onclick = leave;
    $('leaveBattle').onclick = () => { if (confirm('Leave the battle? Your hero becomes an AI teammate.')) leave() };
    $('copy').onclick = async () => {
        try { await navigator.clipboard.writeText(invite()); note('Invite link copied!') } catch { note('Share this link: ' + invite()) }
    };

    // Evolution cards: snapshot-driven, including reconnects.
    const evolutionPanel=document.createElement('section');
    evolutionPanel.style.cssText='display:none;position:fixed;z-index:1000;top:50%;left:50%;transform:translate(-50%,-50%);width:min(94vw,620px);max-height:90dvh;overflow:auto;padding:16px;border:1px solid #d9ad69;border-radius:14px;background:#181121f5;color:#f8e6bd;box-shadow:0 12px 50px #0009;text-align:center';
    document.body.appendChild(evolutionPanel);
    let evolutionKey='';
    function renderEvolution(w){
        const h=w?.heroes.find(h=>h.controller && h.controller===myId()), p=h?.evolutionOffer;
        if(!p){evolutionPanel.style.display='none';evolutionKey='';return;}
        const key=h.name+':'+p.level;
        if(key!==evolutionKey){
            evolutionKey=key;
            evolutionPanel.innerHTML='<div style="font-size:11px;letter-spacing:3px;color:#d9ad69">ASCENSION • LEVEL '+p.level+'</div><h2 style="margin:6px 0 10px;font-size:20px">CHOOSE YOUR EVOLUTION</h2><div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px">'+p.cards.map((c,i)=>'<button type="button" data-evo="'+c.id+'" style="min-width:0;white-space:normal;min-height:110px;padding:10px 6px;border:1px solid #a77d49;border-radius:9px;background:linear-gradient(160deg,#3d2949,#21182e);color:#ffe4ac"><span style="display:block;font-size:25px;margin-bottom:6px">'+['✦','◆','✧'][i]+'</span><strong>'+esc(c.name)+'</strong><span style="display:block;font-size:12px;line-height:1.3;margin-top:6px;color:#e4d8ec">'+esc(c.description)+'</span></button>').join('')+'</div><div data-countdown style="font-size:12px;margin-top:10px;color:#cbb7d2"></div>';
            evolutionPanel.querySelectorAll('[data-evo]').forEach(b=>b.onclick=()=>{
                socket.emit('evolution:choose',{id:Number(b.dataset.evo),level:p.level},res=>{if(!res?.ok)note(res?.error||'Selection expired');});
            });
            evolutionPanel.style.display='block';
        }
        evolutionPanel.querySelector('[data-countdown]').textContent='Protected while choosing • '+Math.max(0,Math.ceil((p.until-w.time)/1000))+'s • Auto-selects when time expires';
    }
    const fusionHint=document.createElement('div');
    fusionHint.setAttribute('role','status');
    fusionHint.style.cssText='display:none;position:fixed;z-index:90;pointer-events:none;text-align:center;padding:5px 9px;border:1px solid #eac67e;border-radius:7px;background:#20152eeb;color:#ffe4a0;font:bold 11px system-ui;white-space:nowrap;box-shadow:0 0 12px #d99a4555';
    document.body.appendChild(fusionHint);
    const fusionPairs={'MARKIE|NOAH':'Dragonstorm','DESTINY|ESPIRIT':"Heaven’s Judgment",'MARKIE|SMITESH':'Cataclysm'};
    let fusionPrevious=new Map();
    function renderFusion(w){
        if(!w){fusionHint.style.display='none';fusionPrevious.clear();return;}
        const h=w.heroes.find(v=>v.controller && v.controller===myId());
        const next=new Map();
        for(const u of w.heroes){
            const old=fusionPrevious.get(u.name);
            next.set(u.name,{n:u.specialN,at:old&&old.n!==u.specialN?w.time:old?.at??-1e9});
        }
        fusionPrevious=next;
        if(!h||h.state||h.fusionCd||h.evolutionOffer){fusionHint.style.display='none';return;}
        const mate=w.heroes.find(u=>u!==h&&u.controller&&!u.state&&!u.fusionCd&&Math.hypot(u.x-h.x,u.y-h.y)<=145&&fusionPairs[[h.name,u.name].sort().join('|')]&&
            (!u.cd||w.time-next.get(u.name).at<=2000));
        if(!mate|| (h.cd&&w.time-next.get(h.name).at>2000)){fusionHint.style.display='none';return;}
        const name=fusionPairs[[h.name,mate.name].sort().join('|')];
        fusionHint.textContent=(mate.cd&&!h.cd?'FUSE NOW!':h.cd?'PARTNER: USE SPECIAL':'FUSION READY')+' · '+name;
        const button=$('special-touch'), rect=button?.getBoundingClientRect();
        fusionHint.style.display='block';
        if(rect&&rect.width&&rect.height){fusionHint.style.left=Math.max(4,Math.min(innerWidth-fusionHint.offsetWidth-4,rect.left+rect.width/2-fusionHint.offsetWidth/2))+'px';fusionHint.style.top=Math.max(4,rect.top-fusionHint.offsetHeight-7)+'px';}
        else{fusionHint.style.left=Math.max(4,(innerWidth-fusionHint.offsetWidth)/2)+'px';fusionHint.style.top='12px';}
    }
    const fieldBanner=document.createElement('div');
    fieldBanner.style.cssText='display:none;position:fixed;top:12%;left:50%;transform:translateX(-50%);z-index:85;pointer-events:none;background:#191320e8;border:1px solid #bd925b;border-radius:7px;padding:5px 12px;color:#ffe1a3;text-align:center;font: bold 11px system-ui;max-width:80vw';
    document.body.appendChild(fieldBanner);
    function renderField(w){
      const f=w?.fieldEvent;
      fieldBanner.style.display=f?'block':'none';
      if(f)fieldBanner.textContent=f.name+' · '+f.desc;
    }
    // Device-local dojo progression; never changes multiplayer combat stats.
    const DOJO_KEY='wch.dojo.v1';
    function loadDojo(){try{return JSON.parse(localStorage.getItem(DOJO_KEY))||{honor:0,runs:0,best:0,heroes:{}}}catch{return {honor:0,runs:0,best:0,heroes:{}}}}
    let dojo=loadDojo(), dojoRun=null;
    const belts=[[0,'White','#eee'],[100,'Yellow','#e9c34d'],[250,'Orange','#ef933e'],[500,'Green','#62b878'],[900,'Blue','#629bea'],[1500,'Purple','#b18ae8'],[2400,'Brown','#ad7955'],[4000,'Black','#bfc3ce']];
    const dojoButton=document.createElement('button');
    dojoButton.textContent='THE DOJO';
    dojoButton.style.cssText='display:block;margin:12px auto;padding:12px 22px;border:1px solid #b99758;border-radius:8px;background:#231c25;color:#ffe0a0;font-weight:800;letter-spacing:2px;cursor:pointer';
    $('entry').appendChild(dojoButton);
    const dojoPanel=document.createElement('div');
    dojoPanel.style.cssText='display:none;position:fixed;inset:0;z-index:150;background:#100e16f5;overflow:auto;padding:24px;color:#f6eee0;font-family:system-ui';
    document.body.appendChild(dojoPanel);
    const armory={NOAH:['Celestial Riftblade','#a99aff'],DESTINY:['Phoenix Excalibur','#ffd17a'],MARKIE:['Worldbreaker Axe','#ff7840'],ESPIRIT:['Heavenpiercer Bow','#ffe59a'],SMITESH:['Staff of the Ancestors','#72f4e7'],DAVE:['Chaos Reaver','#e68aff'],DONNA:['Staff of the Wildmother','#a4ef83']};
    function legendaryEquipped(name){return !!(dojo.equipped?.[name]&&(dojo.heroes[name]?.xp||0)>=400);}
    function renderArmory(){
      const section=document.createElement('section');
      section.innerHTML='<h2>Legendary Armory</h2><p>Reach Mastery 5 (400 XP) with each hero to unlock their weapon. Cosmetic only.</p>';
      for(const [name,[weapon,color]] of Object.entries(armory)){
        const xp=dojo.heroes[name]?.xp||0, unlocked=xp>=400, equipped=legendaryEquipped(name);
        const row=document.createElement('div');row.style.cssText='border:1px solid #514451;border-radius:10px;padding:12px;margin:8px 0';
        row.innerHTML='<small>'+name+'</small><h3 style="margin:5px 0;color:'+color+'">'+weapon+'</h3><progress style="width:100%;accent-color:'+color+'" max="400" value="'+Math.min(400,xp)+'"></progress><button style="margin-top:8px;padding:8px 14px" '+(unlocked?'':'disabled')+'>'+(equipped?'Unequip':unlocked?'Equip':'Locked · '+xp+'/400 XP')+'</button>';
        row.querySelector('button').onclick=()=>{if(!unlocked)return;(dojo.equipped||(dojo.equipped={}))[name]=!equipped;try{localStorage.setItem(DOJO_KEY,JSON.stringify(dojo))}catch{}renderDojo();};
        section.appendChild(row);
      }
      dojoPanel.firstElementChild.appendChild(section);
    }
    function renderDojo(){
      const rank=belts.filter(b=>dojo.honor>=b[0]).pop(), next=belts.find(b=>b[0]>dojo.honor);
      dojoPanel.innerHTML='<div style="max-width:480px;margin:auto"><button id="dojo-close" style="float:right;padding:8px 14px">Close ×</button><div style="color:#c8a66b;letter-spacing:3px;font-size:12px">WEST COAST HEROES</div><h1>THE DOJO</h1><div style="border:1px solid #786344;border-radius:12px;padding:18px"><div style="color:'+rank[2]+';font-weight:800">'+rank[1].toUpperCase()+' BELT</div><h2>'+dojo.honor+' Honor</h2><progress style="width:100%;accent-color:#c8a66b" max="'+(next?next[0]-rank[0]:1)+'" value="'+(next?dojo.honor-rank[0]:1)+'"></progress><small>'+(next?(next[0]-dojo.honor)+' Honor to '+next[1]+' Belt':'Highest rank achieved')+'</small><p>'+dojo.runs+' completed runs · Best wave '+dojo.best+'</p></div><h2>Hero mastery</h2>'+['NOAH','DESTINY','MARKIE','ESPIRIT','SMITESH','DAVE','DONNA'].map(n=>{const h=dojo.heroes[n]||{xp:0,runs:0};return '<div style="padding:12px 0;border-bottom:1px solid #453b49"><b>'+n+'</b><span style="float:right;color:#e5c58b">Mastery '+(1+Math.floor(h.xp/100))+'</span><progress style="width:100%;accent-color:#c8a66b" max="100" value="'+h.xp%100+'"></progress><small>'+h.xp+' XP · '+h.runs+' runs</small></div>'}).join('')+'<p style="opacity:.6;font-size:12px">Progress saved on this device. Ranks are cosmetic.</p></div>';
      renderArmory();
      $('dojo-close').onclick=()=>dojoPanel.style.display='none';
    }
    dojoButton.onclick=()=>{dojo=loadDojo();renderDojo();dojoPanel.style.display='block'};
    function trackDojo(w){
      const h=w.heroes.find(h=>h.controller&&h.controller===myId());
      if(!h)return;
      if(!dojoRun)dojoRun={hero:h.name,wave:1};
      dojoRun.wave=Math.max(dojoRun.wave,w.wave||1);
    }
    function finishDojo(e){
      if(!dojoRun)return;
      const run=dojoRun;dojoRun=null;
      if(e?.reason!=='wipe')return;
      const wave=Math.max(run.wave,Number(e.wave)||1), reward=5+Math.max(0,wave-1)*5;
      dojo=loadDojo();dojo.honor+=reward;dojo.runs++;dojo.best=Math.max(dojo.best,wave);
      const h=dojo.heroes[run.hero]||(dojo.heroes[run.hero]={xp:0,runs:0});h.xp+=reward;h.runs++;
      try{localStorage.setItem(DOJO_KEY,JSON.stringify(dojo))}catch{}
      setTimeout(()=>note('Dojo: +'+reward+' Honor · +'+reward+' '+run.hero+' mastery XP',10000),500);
    }
    const virtueHud=document.createElement('div');
    virtueHud.style.cssText='display:none;position:fixed;left:50%;bottom:max(8px,env(safe-area-inset-bottom));transform:translateX(-50%);width:min(290px,36vw);z-index:80;pointer-events:none;background:#16131de0;border:1px solid #65543b;border-radius:6px;padding:4px 7px;color:#f4e3bf;font:700 9px system-ui';
    const virtueKeys=['honor','loyalty','family','bravery'], virtueColors=['#e5bb63','#78aaff','#79d6a0','#ed8065'];
    virtueHud.innerHTML='<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:5px">'+virtueKeys.map((key,i)=>'<div style="text-align:center">'+key.toUpperCase()+'<div style="height:4px;background:#3a3340;border-radius:3px;overflow:hidden"><div id="virtue-'+key+'" style="height:100%;width:0%;background:'+virtueColors[i]+'"></div></div></div>').join('')+'</div><div id="virtue-surge" style="display:none;text-align:center;color:#ffe3a1;padding:3px"></div>';
    document.body.appendChild(virtueHud);
    function renderVirtues(w){
        virtueHud.style.display=w?.virtues?'block':'none';
        if(!w?.virtues)return;
        for(const key of virtueKeys)$('virtue-'+key).style.width=Math.min(100,w.virtues[key]||0)+'%';
        const surge=$('virtue-surge');surge.style.display=w.virtueSurge?'block':'none';
        surge.textContent=w.virtueSurge?'WAY OF THE WARRIOR · '+w.virtueSurge+'s':'';
    }
    // ---------- server events ----------
    socket.on('room:update', r => { room = r; render() });
    const lootPanel=document.createElement('div');
    lootPanel.style.cssText='display:none;position:fixed;top:18%;left:50%;transform:translateX(-50%);width:min(300px,45vw);z-index:85;background:#151923ed;border:1px solid #c4ab7b;border-radius:12px;padding:10px;color:#eee;text-align:center;font:12px system-ui;box-shadow:0 6px 24px #0008';
    lootPanel.innerHTML='<div id="loot-rarity" style="font-weight:800;letter-spacing:1px"></div><strong id="loot-name"></strong><div id="loot-stat" style="color:#9de3aa;margin:5px"></div><div id="loot-current" style="color:#b8b9c3;font-size:10px"></div><div style="display:flex;gap:6px;margin-top:8px"><button id="loot-equip" style="flex:1;padding:7px;background:#d9b875;color:#20180f">EQUIP</button><button id="loot-salvage" style="flex:1;padding:7px">SALVAGE</button></div>';
    document.body.appendChild(lootPanel);
    const lootHud=document.createElement('div');
    lootHud.style.cssText='display:none;position:fixed;left:50%;top:4px;transform:translateX(-50%);z-index:70;pointer-events:none;color:#eee;background:#151923bb;border-radius:5px;padding:3px 7px;font:10px system-ui';
    document.body.appendChild(lootHud);
    let activeLoot=null;
    const lootDesc=i=>i?'+'+i.value+'% '+({damage:'damage',haste:'attack cooldown reduction',guard:'damage reduction'}[i.stat]||i.stat):'No weapon equipped';
    function renderLoot(w){
        const h=w?.heroes?.find(h=>h.controller===myId()),o=h?.lootOffer;
        activeLoot=o||null;lootPanel.style.display=o&&!w.over&&!h.evolutionOffer?'block':'none';
        lootHud.style.display=h&&!w.over?'block':'none';
        if(h)lootHud.textContent=(h.equipment?h.equipment.name+' · '+lootDesc(h.equipment):'No equipment')+' | Salvage '+h.salvage;
        if(!o)return;
        const c=['#d1d5db','#63a9ff','#bd80ff','#ffbd55','#fff0b0'][o.tier];
        $('loot-rarity').textContent=['COMMON','RARE','EPIC','LEGENDARY','DIVINE'][o.tier];$('loot-rarity').style.color=c;lootPanel.style.borderColor=c;
        $('loot-name').textContent=o.name;$('loot-stat').textContent=lootDesc(o);
        $('loot-current').textContent='Current: '+lootDesc(h.equipment)+' · '+Math.max(0,Math.ceil((o.until-w.time)/1000))+'s';
    }
    function selectLoot(equip){if(activeLoot)socket.emit('loot:choose',{id:activeLoot.id,equip},a=>{if(!a?.ok)note(a?.error||'Loot unavailable')});}
    $('loot-equip').onclick=()=>selectLoot(true);$('loot-salvage').onclick=()=>selectLoot(false);
    const retryPanel=document.createElement('div');
    retryPanel.style.cssText='display:none;position:fixed;inset:0;z-index:1000;background:#090d18bb;align-items:center;justify-content:center;padding:16px';
    retryPanel.innerHTML='<div style="background:#171c2b;border:1px solid #c9a76c;border-radius:18px;padding:20px;text-align:center;color:#f7e7c5;width:min(340px,90vw);box-shadow:0 12px 40px #0008"><div style="font-size:11px;letter-spacing:3px;color:#c9a76c">BOSS CHECKPOINT</div><h2 style="margin:8px 0">Squad defeated</h2><p id="retry-detail"></p><button id="retry-go" style="background:#e5c184;color:#211a12;border:0;border-radius:10px;padding:12px;width:100%;font-weight:800">RETRY CHECKPOINT</button><button id="retry-exit" style="background:transparent;color:#ddd;border:0;padding:12px">Return to lobby</button></div>';
    document.body.appendChild(retryPanel);
    function renderRetry(w){
        const o=w?.retryOffer;retryPanel.style.display=o?'flex':'none';if(!o)return;
        const host=room?.host===myId();
        $('retry-detail').textContent='Boss wave '+o.boss+' · Restart at wave '+o.wave+' · '+o.remaining+' retries remaining';
        $('retry-go').disabled=!host;$('retry-exit').disabled=!host;
        $('retry-go').textContent=host?'RETRY FROM WAVE '+o.wave:'Waiting for host';
    }
    $('retry-go').onclick=()=>socket.emit('battle:retry',{},a=>{if(!a?.ok)note(a?.error||'Retry failed')});
    $('retry-exit').onclick=()=>{const b=[...document.querySelectorAll('button')].find(b=>b!==$('retry-exit')&&b.textContent.toLowerCase().includes('return to lobby'));if(b)b.click();};
    socket.on('battle:start', w => { renderRetry(null); renderLoot(null); resetJoy(); resetAttack(); renderFusion(null); world = w; arena.reset(); arena.push(w); resetPrediction(); reconcile(w); show('battle') });
    socket.on('battle:state', w => { world = w; renderRetry(w); renderLoot(w); trackDojo(w); reconcile(w); arena.push(w); renderEvolution(w); renderFusion(w); renderField(w); renderVirtues(w) });
    socket.on('battle:end', e => {
        renderRetry(null); renderLoot(null); finishDojo(e); renderField(null); renderVirtues(null);
        resetJoy(); world = null; renderEvolution(null); renderFusion(null); arena.reset(); resetPrediction();
        if (e?.reason === 'wipe') note('Squad defeated on wave ' + e.wave + ' — score ' + e.score + ', ' + e.kills + ' KOs. Ready up to play again!', 12000);
        else note('Back in the lobby' + (e?.by ? ' — ' + e.by + ' ended the round.' : '.'));
    });
    socket.on('session:replaced', () => { me = null; room = null; world = null; arena.reset(); show('entry'); note('This game was opened in another tab or window.') });
    socket.on('disconnect', reason => {
        resetJoy();
        $('status').textContent = 'Disconnected — reconnecting…';
        if (room) { $('conn').classList.remove('hidden'); note('Connection lost (' + reason + ') — reconnecting…') }
    });
    socket.io.on('reconnect_error', () => { if (room) $('status').textContent = 'Trying to reconnect…'; });
    // iOS Safari may suspend sockets when switching apps or locking the screen.
    // Wake the transport promptly instead of waiting for a stale heartbeat timeout.
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && !socket.connected) socket.connect();
    });
    window.addEventListener('pageshow', () => { if (!socket.connected) socket.connect(); });
    socket.on('connect', () => {
        $('status').textContent = 'Connected';
        resume(); // first load (refresh) or after a drop
    });

    const urlRoom = params.get('room');
    if (urlRoom && !storedSession()) { $('roomCode').value = urlRoom.toUpperCase(); note('Enter your name, then tap JOIN ROOM.') }
    try { const n = localStorage.getItem('wch.name'); if (n) $('name').value = n } catch {}
    $('name').addEventListener('change', () => { try { localStorage.setItem('wch.name', $('name').value) } catch {} });

    // ---------- prediction ----------
    function myHeroIndex(w) { return w ? w.heroes.findIndex(h => h.controller && h.controller === myId()) : -1 }
    // Same speed the server uses: the snapshot's effective speed (spd includes HASTE x1.5), else the
    // hero's base V19 speed converted to world units per input.
    const speedOf = i => { const h = world && world.heroes[i]; return h && Number.isFinite(h.spd) && h.spd > 0 ? h.spd : SIM.speedFromV19(ROSTER[i].v19.speed) };
    const canMove = w => { const i = myHeroIndex(w); return i >= 0 && !w.heroes[i].state && !w.over };
    function resetPrediction() { pending = []; predicted = null; predictedFor = null; visualOffset = { x: 0, y: 0 } }
    function reconcile(w) {
        const i = myHeroIndex(w);
        if (i < 0 || !predictionOn) { if (predicted) resetPrediction(); return }
        const h = w.heroes[i];
        pending = pending.filter(p => p.seq > h.seq);
        const next = { x: h.x, y: h.y, facing: h.facing, vx: h.vx, vy: h.vy, aim: h.aim }; // velocity + aim too, so acceleration replays exactly
        if (!h.state && !w.over) for (const p of pending) SIM.stepHero(next, p.move, speedOf(i)); // downed: no movement to replay
        if (predicted && predictedFor === i) {
            // Keep what's on screen continuous: the correction fades out over a few frames.
            visualOffset.x += predicted.x - next.x;
            visualOffset.y += predicted.y - next.y;
            if (Math.hypot(visualOffset.x, visualOffset.y) > 80) visualOffset = { x: 0, y: 0 };
        }
        predicted = next;
        predictedFor = i;
    }
    function localHero() {
        if (!predicted || !predictionOn) return null;
        visualOffset.x *= 0.8; visualOffset.y *= 0.8;
        return { index: predictedFor, x: predicted.x + visualOffset.x, y: predicted.y + visualOffset.y, facing: predicted.facing, aim: predicted.aim, moving: performance.now() - lastLocalMove < 120 };
    }

    // ---------- input ----------
    function readMove() {
        let x = (keys.d || keys.arrowright ? 1 : 0) - (keys.a || keys.arrowleft ? 1 : 0);
        let y = (keys.s || keys.arrowdown ? 1 : 0) - (keys.w || keys.arrowup ? 1 : 0);
        if (!x && !y) { x = touch.x; y = touch.y }
        return SIM.normalizeMove(x, y);
    }
    function tickInput() {
        if (!socket.connected || !room || room.phase !== 'battle' || !world || myHeroIndex(world) < 0) return;
        const move = readMove();
        const attack = !!(keys[' '] || touch.attack || tapped.attack), special = !!(keys.q || touch.special || tapped.special);
        tapped.attack = tapped.special = false;
        seq++;
        socket.emit('player:input', { seq, x: move.x, y: move.y, attack, special, aim: attack && (touch.attack || !keys[' ']) ? attackAim : null });
        if(!touch.attack)attackAim=null;
        if (predictionOn && predicted) {
            pending.push({ seq, move });
            if (pending.length > 120) pending.shift();
            if (canMove(world) && SIM.stepHero(predicted, move, speedOf(predictedFor))) lastLocalMove = performance.now();
        }
    }
    setInterval(tickInput, SIM.TICK_MS);
    addEventListener('keydown', e => {
        if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
        keys[e.key.toLowerCase()] = true;
        if (e.key === ' ') tapped.attack = true;
        if (e.key.toLowerCase() === 'q') tapped.special = true;
        if (e.key.startsWith('Arrow') || (e.key === ' ' && document.body.classList.contains('in-battle'))) e.preventDefault();
    });
    addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false });
    addEventListener('blur', () => { for (const k in keys) keys[k] = false; resetJoy(); touch.attack = touch.special = false });

    // iOS Safari can lose pointer capture when the finger crosses an overlay,
    // the browser toolbar appears, or the page changes visibility. Always
    // release on global end/cancel as well as on the joystick itself.
    const joy = $('joystick'), stick = $('stick');
    let joyPointer = null, joyLastEvent = 0;
    function moveStick(e) {
        const r = joy.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        let dx = e.clientX - cx, dy = e.clientY - cy;
        const radius = r.width * .32, dist = Math.hypot(dx, dy) || 1;
        if (dist > radius) { dx = dx / dist * radius; dy = dy / dist * radius }
        stick.style.transform = `translate(calc(-50% + ${dx}px),calc(-50% + ${dy}px))`;
        const dead = radius * .2, mag = Math.hypot(dx, dy);
        if (mag < dead) { touch.x = touch.y = 0; return }
        const k = Math.min(1, (mag - dead) / (radius - dead)) / mag;
        touch.x = dx * k; touch.y = dy * k;
    }
    function resetJoy() {
        joyPointer = null; joyLastEvent = 0;
        joy.classList.remove('active');
        stick.style.transform = 'translate(-50%,-50%)';
        touch.x = touch.y = 0;
    }
    joy.addEventListener('pointerdown', e => {
        e.preventDefault();
        if (joyPointer !== null) return;
        joyPointer = e.pointerId;
        joyLastEvent = performance.now();
        joy.classList.add('active');
        try { joy.setPointerCapture(e.pointerId) } catch {}
        moveStick(e);
    });
    joy.addEventListener('pointermove', e => {
        if (e.pointerId === joyPointer) {
            e.preventDefault(); joyLastEvent = performance.now(); moveStick(e);
        }
    });
    const releaseJoy = e => { if (e.pointerId === joyPointer) resetJoy() };
    for (const evt of ['pointerup','pointercancel','lostpointercapture'])
        joy.addEventListener(evt,releaseJoy);
    // Window capture catches release even if Safari sends it outside the control.
    for (const evt of ['pointerup','pointercancel'])
        window.addEventListener(evt,releaseJoy,true);
    // Touchend/touchcancel are a fallback when iOS drops the pointer stream.
    for (const evt of ['touchend','touchcancel'])
        window.addEventListener(evt,e=>{
            if(joyPointer===null)return;
            if(e.touches.length===0)resetJoy();
        },{passive:true,capture:true});
    document.addEventListener('visibilitychange',()=>{if(document.hidden)resetJoy()});
    window.addEventListener('pagehide',resetJoy);
    // Safari occasionally fails to deliver any end event. The fallback only
    // triggers after prolonged silence, never during ordinary joystick use.
    setInterval(()=>{
        if(joyPointer!==null && performance.now()-joyLastEvent>12000)resetJoy();
    },1000);
    function bindButton(id, field) {
        const b = $(id);
        let pointer = null;
        b.addEventListener('pointerdown', e => {
            e.preventDefault();
            if (pointer !== null) return;
            pointer = e.pointerId;
            try { b.setPointerCapture(e.pointerId) } catch {}
            touch[field] = true;
            tapped[field] = true;
            b.classList.add('pressed');
        });
        for (const evt of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(evt, e => {
            if (pointer === e.pointerId) { pointer = null; touch[field] = false; b.classList.remove('pressed') }
        });
    }
    let attackAim=null, attackPointer=null;
    const attackJoy=$('attack-touch');
    attackJoy.style.touchAction='none';attackJoy.style.position='relative';
    attackJoy.innerHTML='<span style="pointer-events:none">⚔<br>ATTACK</span><span id="attack-knob" style="pointer-events:none;position:absolute;left:50%;top:50%;width:28px;height:28px;border:2px solid #ffe2a1;border-radius:50%;background:#ffd27944;transform:translate(-50%,-50%);display:none"></span>';
    const attackKnob=$('attack-knob');
    function aimAttack(e){const r=attackJoy.getBoundingClientRect(),dx=e.clientX-r.left-r.width/2,dy=e.clientY-r.top-r.height/2,d=Math.hypot(dx,dy),m=Math.min(d,r.width*.32);if(d>7){attackAim=SIM.dir8Of(dx,dy);attackKnob.style.transform='translate(calc(-50% + '+dx/d*m+'px),calc(-50% + '+dy/d*m+'px))';}}
    function resetAttack(){attackPointer=null;touch.attack=false;attackJoy.classList.remove('pressed');attackKnob.style.display='none';attackKnob.style.transform='translate(-50%,-50%)';}
    attackJoy.addEventListener('pointerdown',e=>{e.preventDefault();if(attackPointer!==null)return;attackPointer=e.pointerId;attackAim=null;try{attackJoy.setPointerCapture(e.pointerId)}catch{}touch.attack=true;tapped.attack=true;attackJoy.classList.add('pressed');attackKnob.style.display='block';aimAttack(e);});
    attackJoy.addEventListener('pointermove',e=>{if(e.pointerId===attackPointer){e.preventDefault();aimAttack(e);}});
    const releaseAttack=e=>{if(e.pointerId===attackPointer)resetAttack();};
    for(const evt of ['pointerup','pointercancel','lostpointercapture'])attackJoy.addEventListener(evt,releaseAttack);
    for(const evt of ['pointerup','pointercancel'])window.addEventListener(evt,releaseAttack,true);
    window.addEventListener('blur',resetAttack);window.addEventListener('pagehide',resetAttack);
    document.addEventListener('visibilitychange',()=>{if(document.hidden)resetAttack();});
    window.addEventListener('touchend',e=>{if(!e.touches.length)resetAttack();},{passive:true});
    bindButton('special-touch', 'special');
    document.addEventListener('touchmove', e => { if (e.target.closest('#touch-controls')) e.preventDefault() }, { passive: false });

    // ---------- arena ----------
    const arena = WCHArena.createArena($('arena'), {
        getRoom: () => room,
        getMyId: myId,
        legendaryEquipped,
        getLocalHero: localHero,
        interpolate: params.get('interp') !== '0'
    });
    arena.start();
    setInterval(() => { if (room?.phase === 'battle') renderSquad() }, 1000); // reconnect countdowns
    // Debug/test hook (read-only views).
    window.__wch = { arena, getWorld: () => world, getRoom: () => room, getMe: () => me, getPending: () => pending.length, getPredicted: () => predicted, socket };
})();
