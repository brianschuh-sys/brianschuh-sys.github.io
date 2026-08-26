/*
  Defense Trainer - shared engine
  ================================
  Everything in this file is defense-agnostic: field drawing, coordinate math,
  offense token dragging/clicking, defender token rendering, and the render loop.

  A defense-specific page (man-to-man.html, box-and-one.html, etc.) supplies its
  own rules by calling DefenseEngine.init(config). See the hook descriptions below.

  CONFIG SHAPE
  ------------
  {
    initialOffense: [{x,y}, ...],       // starting offensive positions
    initialBallIndex: 0,                // who starts with the ball

    attackerCount: { adjustable: true, min: 2, max: 6 }
                 | { adjustable: false, fixed: 6 },

    defaultDefenderColor: '#2f9bd6',    // used when a defender target has no color of its own
    alwaysSmoothMovement: false,        // opt out of the instant-snap behavior for
                                         // engaged defenders entirely - they still get
                                         // the ring highlight, they just glide there
                                         // like everyone else instead of teleporting

    // REQUIRED. Given the offense array and who has the ball, return one entry
    // per defender: { pos:{x,y}, engaged:bool, color?:'#hex' }.
    computeDefenders(offense, ballIndex, helpers) -> [{pos, engaged, color}, ...]

    // OPTIONAL. Called at the very top of every render (including live, mid-drag
    // renders) - use this for state tracking / auto-firing triggers that should
    // happen live as the ball moves, with no click required.
    onBeforeRender(offense, ballIndex, helpers) {}

    // OPTIONAL. Called when the user CLICKS a different offensive token to give
    // them the ball (never on a drag) - BEFORE ballIndex is updated, so you can
    // still read who the old carrier was. Side effects only; return value ignored.
    onPass(newIdx, offense, ballIndex, helpers) {}

    // OPTIONAL. Called once at init, and again any time the Reset button (if
    // present) is clicked, right after offense/ballIndex are restored to their
    // initial values. Use this to reset any defense-specific persistent state.
    onReset(offense, ballIndex, helpers) {}

    // OPTIONAL. Draw extra static-ish overlay content (zone lines, labels) into
    // the zone layer. Called every render, after the layer has been cleared.
    drawZoneOverlay(zoneLayer, helpers) {}

    // OPTIONAL. Draw denial lanes or other lines into the lane layer, after
    // defenders have been computed. Called every render, after the layer has
    // been cleared and the shot lane (ball -> goal) has already been drawn.
    drawLanes(laneLayer, defenders, offense, ballIndex, helpers) {}
  }

  HELPERS
  -------
  Every hook above receives a `helpers` object with the shared geometry:
    toPx, toYd, dist, lerp, clamp, el,
    GOAL, PAINT, INNER_BOX, paintMidY, FIELD_X, FIELD_Y,
    inPaint(pt), nearestRectPoint(pt, rect)
  It's also available as DefenseEngine.helpers immediately after this script
  loads, so a page can reference e.g. DefenseEngine.helpers.PAINT while building
  its own defense-specific constants at the top level, before calling init().
*/
(function(){
  const NS = 'http://www.w3.org/2000/svg';

  // ---- coordinate system: yards. Goal at (0,0). +y = upfield (away from goal). ----
  const PX_PER_YD = 20;
  const ORIGIN_X = 440;   // px, where x=0 yd sits
  const ORIGIN_Y = 440;   // px, where y=0 yd (goal line) sits
  const FIELD_X = [-21, 21];   // yd
  const FIELD_Y = [-15, 21];   // yd (15 yd behind the goal, standard field depth)

  function toPx(pt){ return { x: ORIGIN_X + pt.x*PX_PER_YD, y: ORIGIN_Y - pt.y*PX_PER_YD }; }
  function toYd(px, py){ return { x: (px-ORIGIN_X)/PX_PER_YD, y: (ORIGIN_Y-py)/PX_PER_YD }; }
  function dist(a,b){ return Math.hypot(a.x-b.x, a.y-b.y); }
  function lerp(a,b,t){ return { x:a.x+(b.x-a.x)*t, y:a.y+(b.y-a.y)*t }; }
  function clamp(v,lo,hi){ return Math.max(lo, Math.min(hi, v)); }

  function el(tag, attrs){
    const e = document.createElementNS(NS, tag);
    for(const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  const GOAL = {x:0, y:0};
  const CREASE_BUFFER = 3.3; // offensive players may not enter the crease

  // "The paint": 3-12 yd in front of goal (top of crease extended), 5 yd either side.
  // Shared because both man-to-man sag behavior and zone-style schemes reference it.
  const PAINT = { xHalf: 5, yNear: 3, yFar: 12 };
  function inPaint(pt){
    return pt.x >= -PAINT.xHalf && pt.x <= PAINT.xHalf && pt.y >= PAINT.yNear && pt.y <= PAINT.yFar;
  }
  function nearestRectPoint(pt, rect){
    return { x: clamp(pt.x, -rect.xHalf, rect.xHalf), y: clamp(pt.y, rect.yNear, rect.yFar) };
  }
  const paintMidY = (PAINT.yNear + PAINT.yFar) / 2;
  // Inner 5x5 yd box, centered in the paint - the deepest a weak-side defender collapses to.
  const INNER_BOX = { xHalf: 2.5, yNear: paintMidY - 2.5, yFar: paintMidY + 2.5 };

  // "Good shot" zone: within 15 yards of goal, and not so far to the side that the
  // goal appears narrower than about 2 feet wide to the shooter (matches the same
  // 15yd/60deg geometry already used for Box and 1's on-ball defenders). Runs from
  // the crease's visual edge (3 yd) outward, so it doesn't shade over the crease
  // itself. Built as a many-point polygon approximating the arc rather than true SVG
  // arc commands, since sweep-flag direction is easy to get backwards once yard-space
  // (y-up) gets converted to pixel-space (y-down) - a polygon sidesteps that entirely
  // and looks identically smooth at this point count.
  const SHOT_ZONE_OUTER_R = 15;
  const SHOT_ZONE_INNER_R = 3;
  const SHOT_ZONE_HALF_ANGLE = Math.PI / 3; // 60 deg
  function buildShotZonePath(){
    const steps = 48;
    const pts = [];
    for(let i = 0; i <= steps; i++){
      const t = -SHOT_ZONE_HALF_ANGLE + (2 * SHOT_ZONE_HALF_ANGLE) * (i / steps);
      pts.push({ x: SHOT_ZONE_OUTER_R * Math.sin(t), y: SHOT_ZONE_OUTER_R * Math.cos(t) });
    }
    for(let i = 0; i <= steps; i++){
      const t = SHOT_ZONE_HALF_ANGLE - (2 * SHOT_ZONE_HALF_ANGLE) * (i / steps);
      pts.push({ x: SHOT_ZONE_INNER_R * Math.sin(t), y: SHOT_ZONE_INNER_R * Math.cos(t) });
    }
    const pxPts = pts.map(toPx);
    return 'M ' + pxPts.map(p => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' L ') + ' Z';
  }

  // The on-ball defender is facing the ball carrier, and RIGHT/LEFT communication
  // calls represent HIS OWN left/right - i.e. who's covering the next attacker around
  // the goal from him, going clockwise (his right) vs counter-clockwise (his left).
  // "Around the goal" - not simple x-position - because a defender's own left/right
  // rotates with wherever on the field he actually is; a clockwise/counter-clockwise
  // ring naturally stays correct regardless of where play is happening.
  //
  // angleAroundGoal: 0 = straight upfield, increasing = clockwise (matches the fan/
  // shot-angle convention used elsewhere - dx,dy order intentionally swapped so
  // "straight ahead" is angle 0).
  function angleAroundGoal(pt){
    return Math.atan2(pt.x - GOAL.x, pt.y - GOAL.y);
  }

  // Given a list of {x,y} points (e.g. offensive players, or zone home positions) and
  // the index of whichever one is "on the ball," find the immediate clockwise and
  // counter-clockwise neighbors around the goal (wrapping past +/-180deg correctly).
  // Returns { cwIdx, ccwIdx }.
  function findRingNeighbors(points, onBallIdx){
    if(onBallIdx === null || onBallIdx === undefined) return { cwIdx: null, ccwIdx: null };
    const order = points.map((p,i) => ({ i, a: angleAroundGoal(p) })).sort((p,q) => p.a - q.a);
    const pos = order.findIndex(e => e.i === onBallIdx);
    if(pos === -1 || order.length < 2) return { cwIdx: null, ccwIdx: null };
    const cwIdx = order[(pos + 1) % order.length].i;
    const ccwIdx = order[(pos - 1 + order.length) % order.length].i;
    return { cwIdx, ccwIdx };
  }

  const helpers = {
    toPx, toYd, dist, lerp, clamp, el,
    GOAL, PAINT, INNER_BOX, paintMidY, FIELD_X, FIELD_Y,
    inPaint, nearestRectPoint, angleAroundGoal, findRingNeighbors
  };

  function buildField(staticLayer){
    staticLayer.innerHTML = '';

    const w = 880, h = 760;
    // background turf
    staticLayer.appendChild(el('rect', {x:0,y:0,width:w,height:h,fill:'#1c8a4f'}));
    // subtle vertical shading bands for depth
    const grad = el('linearGradient', {id:'turfGrad', x1:'0', y1:'0', x2:'0', y2:'1'});
    grad.appendChild(el('stop', {offset:'0%', 'stop-color':'#1f974f'}));
    grad.appendChild(el('stop', {offset:'100%', 'stop-color':'#187a46'}));
    const defs = el('defs', {});
    defs.appendChild(grad);
    staticLayer.appendChild(defs);
    staticLayer.appendChild(el('rect', {x:0,y:0,width:w,height:h,fill:'url(#turfGrad)'}));

    // 5-yard grid lines
    for(let y = FIELD_Y[0]; y <= FIELD_Y[1]; y += 5){
      const p1 = toPx({x:FIELD_X[0], y}), p2 = toPx({x:FIELD_X[1], y});
      const bold = (Math.abs(y-10) < 0.01 || Math.abs(y-15)<0.01);
      staticLayer.appendChild(el('line', {
        x1:p1.x, y1:p1.y, x2:p2.x, y2:p2.y,
        stroke: bold ? 'rgba(15,60,120,0.85)' : 'rgba(20,75,145,0.65)',
        'stroke-width': bold ? 2 : 1,
        'stroke-dasharray': '5 5'
      }));
    }
    for(let x = -20; x <= 20; x += 5){
      const p1 = toPx({x, y:FIELD_Y[0]}), p2 = toPx({x, y:FIELD_Y[1]});
      staticLayer.appendChild(el('line', {
        x1:p1.x, y1:p1.y, x2:p2.x, y2:p2.y,
        stroke:'rgba(20,75,145,0.55)', 'stroke-width':1, 'stroke-dasharray':'5 5'
      }));
    }

    // hash marks (yellow) at x = -9, +9
    [-9, 9].forEach(hx=>{
      const p1 = toPx({x:hx, y:FIELD_Y[0]}), p2 = toPx({x:hx, y:FIELD_Y[1]});
      staticLayer.appendChild(el('line', {
        x1:p1.x, y1:p1.y, x2:p2.x, y2:p2.y,
        stroke:'#f2c14e', 'stroke-width':3, 'stroke-dasharray':'10 8', opacity:0.9
      }));
    });

    // goal line (white dashed, full width)
    {
      const p1 = toPx({x:FIELD_X[0], y:0}), p2 = toPx({x:FIELD_X[1], y:0});
      staticLayer.appendChild(el('line', {
        x1:p1.x, y1:p1.y, x2:p2.x, y2:p2.y,
        stroke:'rgba(255,255,255,0.85)', 'stroke-width':2, 'stroke-dasharray':'9 7'
      }));
    }

    // crease circle (radius 3 yd), green fill so grid doesn't show through, white outline
    const creaseC = toPx({x:0,y:0});
    const creaseR = 3*PX_PER_YD;
    staticLayer.appendChild(el('circle', {cx:creaseC.x, cy:creaseC.y, r:creaseR, fill:'#1c8a4f'}));
    staticLayer.appendChild(el('circle', {cx:creaseC.x, cy:creaseC.y, r:creaseR, fill:'none', stroke:'#ffffff', 'stroke-width':3}));
    // redraw goal-line-extended dashes across the crease interior
    {
      const y0 = creaseC.y;
      const xStart = creaseC.x - creaseR + 3, xEnd = creaseC.x + creaseR - 3;
      const dash=7, gap=6;
      let x = xStart;
      while(x < xEnd){
        const x2 = Math.min(x+dash, xEnd);
        staticLayer.appendChild(el('line', {x1:x,y1:y0,x2:x2,y2:y0, stroke:'#ffffff', 'stroke-width':2}));
        x += dash+gap;
      }
    }

    // goal mouth (red), 2 yd wide, centered at 0,0
    {
      const gp1 = toPx({x:-1, y:0}), gp2 = toPx({x:1, y:0});
      staticLayer.appendChild(el('line', {x1:gp1.x,y1:gp1.y,x2:gp2.x,y2:gp2.y, stroke:'#d23a24', 'stroke-width':6, 'stroke-linecap':'round'}));
    }

    // field border
    staticLayer.appendChild(el('rect', {x:1,y:1,width:w-2,height:h-2, fill:'none', stroke:'rgba(255,255,255,0.3)', 'stroke-width':2}));

    // solid white boundary lines: the offensive box (side boards) and the endline (behind the goal)
    {
      const topLeft = toPx({x:FIELD_X[0], y:20});
      const botLeft = toPx({x:FIELD_X[0], y:FIELD_Y[0]});
      const topRight = toPx({x:FIELD_X[1], y:20});
      const botRight = toPx({x:FIELD_X[1], y:FIELD_Y[0]});
      // side boards (offensive box)
      staticLayer.appendChild(el('line', {x1:topLeft.x, y1:topLeft.y, x2:botLeft.x, y2:botLeft.y, stroke:'#ffffff', 'stroke-width':4, 'stroke-linecap':'round'}));
      staticLayer.appendChild(el('line', {x1:topRight.x, y1:topRight.y, x2:botRight.x, y2:botRight.y, stroke:'#ffffff', 'stroke-width':4, 'stroke-linecap':'round'}));
      // endline (behind the goal)
      staticLayer.appendChild(el('line', {x1:botLeft.x, y1:botLeft.y, x2:botRight.x, y2:botRight.y, stroke:'#ffffff', 'stroke-width':4, 'stroke-linecap':'round'}));
      // top of the box, 20 yd from the goal
      const topL20 = toPx({x:FIELD_X[0], y:20});
      const topR20 = toPx({x:FIELD_X[1], y:20});
      staticLayer.appendChild(el('line', {x1:topL20.x, y1:topL20.y, x2:topR20.x, y2:topR20.y, stroke:'#ffffff', 'stroke-width':4, 'stroke-linecap':'round'}));
    }

    // "the paint": 3-12 yd in front of goal, 5 yd either side
    {
      const tl = toPx({x:-PAINT.xHalf, y:PAINT.yFar});
      const br = toPx({x:PAINT.xHalf, y:PAINT.yNear});
      const g = el('g', {id:'paintZone'});
      g.appendChild(el('rect', {
        x:tl.x, y:tl.y, width:(br.x-tl.x), height:(br.y-tl.y),
        fill:'rgba(242,193,78,0.10)', stroke:'rgba(242,193,78,0.65)',
        'stroke-width':2, 'stroke-dasharray':'8 6'
      }));
      // inner 5x5 yd collapse box
      const itl = toPx({x:-2.5, y:paintMidY+2.5});
      const ibr = toPx({x:2.5, y:paintMidY-2.5});
      g.appendChild(el('rect', {
        x:itl.x, y:itl.y, width:(ibr.x-itl.x), height:(ibr.y-itl.y),
        fill:'none', stroke:'rgba(242,193,78,0.4)',
        'stroke-width':1.5, 'stroke-dasharray':'3 4'
      }));
      staticLayer.appendChild(g);
    }

    // "10" / "15" yard labels near right edge
    [10,15].forEach(yd=>{
      const p = toPx({x:FIELD_X[1]-1.2, y:yd});
      const t = el('text', {x:p.x, y:p.y+4, fill:'rgba(255,255,255,0.55)', 'font-size':'12', 'font-family':"'Barlow Condensed', sans-serif", 'text-anchor':'end'});
      t.textContent = yd + ' yd';
      staticLayer.appendChild(t);
    });
  }

  function init(config){
    const svg = document.getElementById('field');

    // ---------------- layers ----------------
    const staticLayer = el('g', {id:'staticLayer'});
    const zoneLayer = el('g', {id:'zoneLayer'});
    const laneLayer = el('g', {id:'laneLayer'});
    const tokenLayer = el('g', {id:'tokenLayer'});
    const defenderLayer = el('g', {id:'defenderLayer'});
    const offenseLayer = el('g', {id:'offenseLayer'});
    svg.appendChild(staticLayer);
    svg.appendChild(zoneLayer);
    svg.appendChild(laneLayer);
    svg.appendChild(tokenLayer);
    tokenLayer.appendChild(defenderLayer);
    tokenLayer.appendChild(offenseLayer);

    // ---------------- persistent DOM nodes ----------------
    // Defender nodes: persistent so their transform transitions can animate smoothly.
    let defenderNodes = [];
    function ensureDefenderNodes(n){
      while(defenderNodes.length < n){
        const g = el('g', {class:'defender-token'});
        const ring = el('circle', {cx:0, cy:0, r:15, fill:'none', stroke:'#e8452c', 'stroke-width':2.5, class:'onball-ring'});
        ring.style.display = 'none';
        const dot = el('circle', {cx:0, cy:0, r:11, fill:'#2f9bd6', stroke:'#123', 'stroke-width':1.5, class:'defender-dot'});
        // Communication call-out: a pill below the token, shown only when the
        // COMMUNICATION toggle is on and this defender has something to say. Sized
        // 3x the original for readability.
        const callBg = el('rect', {x:-24, y:18, width:48, height:45, rx:10, fill:'rgba(10,15,13,0.88)', stroke:'rgba(255,255,255,0.25)', 'stroke-width':1.5, class:'call-bg'});
        callBg.style.display = 'none';
        const callText = el('text', {x:0, y:51, 'text-anchor':'middle', 'font-size':'28', fill:'#f4efe3', 'font-family':"'Barlow Condensed', sans-serif", 'font-weight':'700', 'letter-spacing':'0.03em', class:'call-text'});
        callText.style.display = 'none';
        g.appendChild(ring); g.appendChild(dot); g.appendChild(callBg); g.appendChild(callText);
        defenderLayer.appendChild(g);
        defenderNodes.push({g, ring, dot, callBg, callText});
      }
      while(defenderNodes.length > n){
        const node = defenderNodes.pop();
        node.g.remove();
      }
    }

    // Offense nodes: persistent - must NOT be destroyed/recreated during a drag, since
    // mobile browsers tie touch tracking to the original element.
    let offenseNodes = [];
    function ensureOffenseNodes(n){
      while(offenseNodes.length < n){
        const idx = offenseNodes.length;
        const g = el('g', {class:'token'});
        const hit = el('circle', {cx:0, cy:0, r:26, fill:'rgba(0,0,0,0.001)', 'pointer-events':'all'});
        const paintRing = el('circle', {cx:0, cy:0, r:17, fill:'none', stroke:'#f2c14e', 'stroke-width':2, 'stroke-dasharray':'3 3'});
        paintRing.style.display = 'none';
        const dot = el('circle', {cx:0, cy:0, r:13, stroke:'#3a1c0f', 'stroke-width':1.5});
        const label = el('text', {x:0, y:5, 'text-anchor':'middle', 'font-size':'16', fill:'#1b0f08', 'font-family':"'Barlow Condensed', sans-serif", 'font-weight':'700', 'pointer-events':'none'});
        g.appendChild(hit); g.appendChild(paintRing); g.appendChild(dot); g.appendChild(label);
        offenseLayer.appendChild(g);
        attachDrag(g, idx);
        offenseNodes.push({g, hit, paintRing, dot, label});
      }
      while(offenseNodes.length > n){
        const node = offenseNodes.pop();
        node.g.remove();
      }
    }

    // ---------------- state ----------------
    let offense = config.initialOffense.map(p => ({x:p.x, y:p.y}));
    let ballIndex = config.initialBallIndex || 0;

    // ---------------- render ----------------
    function render(){
      laneLayer.innerHTML = '';
      zoneLayer.innerHTML = '';

      const ball = offense[ballIndex];

      if(shotZoneToggleEl && shotZoneToggleEl.checked){
        zoneLayer.appendChild(el('path', {
          d: buildShotZonePath(),
          fill: 'rgba(242,193,78,0.16)',
          stroke: 'rgba(242,193,78,0.55)',
          'stroke-width': 1.5,
          'stroke-dasharray': '5 4'
        }));
      }

      if(config.onBeforeRender) config.onBeforeRender(offense, ballIndex, helpers);
      if(config.drawZoneOverlay) config.drawZoneOverlay(zoneLayer, helpers);

      // shot lane: ball -> goal (generic to every scheme)
      {
        const p1 = toPx(ball), p2 = toPx(GOAL);
        laneLayer.appendChild(el('line', {
          x1:p1.x,y1:p1.y,x2:p2.x,y2:p2.y,
          stroke:'rgba(232,69,44,0.55)', 'stroke-width':2, 'stroke-dasharray':'6 6'
        }));
      }

      const defenders = config.computeDefenders(offense, ballIndex, helpers);

      if(config.drawLanes) config.drawLanes(laneLayer, defenders, offense, ballIndex, helpers);

      // defender tokens: update persistent nodes so movement animates smoothly.
      // "engaged" defenders snap instantly instead, tracking with no delay.
      ensureDefenderNodes(defenders.length);
      const commOn = commToggleEl ? commToggleEl.checked : false;
      // Some schemes (Rotation) reshape the whole defense on every single pass, and
      // having some defenders snap instantly while others glide looks jarring given
      // how often that happens - so a page can opt out of the instant-snap behavior
      // entirely via config.alwaysSmoothMovement while still keeping the engaged-ring
      // highlight, which is a separate visual signal from how the token moves.
      const smoothOverride = !!config.alwaysSmoothMovement;
      defenders.forEach((d,i)=>{
        const p = toPx(d.pos);
        const node = defenderNodes[i];
        node.ring.style.display = d.engaged ? '' : 'none';
        const snapInstantly = d.engaged && !smoothOverride;
        node.g.style.transition = snapInstantly ? 'none' : '';
        if(snapInstantly) node.g.getBoundingClientRect(); // force a reflow so the browser
          // actually commits transition:none before the transform below changes -
          // otherwise an element that was mid-transition can keep animating from its
          // stale position instead of snapping instantly, since setting transition
          // and transform in the same tick doesn't reliably cancel an in-flight one.
        node.g.setAttribute('transform', `translate(${p.x} ${p.y})`);
        node.dot.setAttribute('fill', d.color || config.defaultDefenderColor || '#2f9bd6');

        const call = commOn ? (d.call || '') : '';
        if(call){
          node.callText.textContent = call;
          const w = Math.max(90, call.length*19.5+36); // 3x the original width formula
          node.callBg.setAttribute('x', -w/2);
          node.callBg.setAttribute('width', w);
          node.callBg.style.display = '';
          node.callText.style.display = '';
        } else {
          node.callBg.style.display = 'none';
          node.callText.style.display = 'none';
        }
      });

      // offense tokens (draggable + clickable): update persistent nodes in place.
      ensureOffenseNodes(offense.length);
      offense.forEach((o,i)=>{
        const p = toPx(o);
        const isBall = (i === ballIndex);
        const node = offenseNodes[i];
        node.g.setAttribute('transform', `translate(${p.x} ${p.y})`);
        node.paintRing.style.display = (!isBall && inPaint(o)) ? '' : 'none';
        node.dot.setAttribute('fill', isBall ? '#e8452c' : '#f2934a');
        node.label.textContent = isBall ? 'B' : 'O';
      });

      const countLabel = document.getElementById('countLabel');
      if(countLabel) countLabel.textContent = offense.length;
      const removeBtn = document.getElementById('removeBtn');
      const addBtn = document.getElementById('addBtn');
      const ac = config.attackerCount || { adjustable:false };
      if(removeBtn) removeBtn.disabled = !ac.adjustable || offense.length <= (ac.min || 2);
      if(addBtn) addBtn.disabled = !ac.adjustable || offense.length >= (ac.max || 6);
    }

    // ---------------- drag / click handling ----------------
    function svgPoint(evt){
      const rect = svg.getBoundingClientRect();
      const scaleX = 880 / rect.width;
      const scaleY = 760 / rect.height;
      const px = (evt.clientX - rect.left) * scaleX;
      const py = (evt.clientY - rect.top) * scaleY;
      return toYd(px, py);
    }

    function attachDrag(g, idx){
      let dragging = false;
      let moved = false;
      let startClient = null;

      function onDown(evt){
        evt.preventDefault();
        dragging = true;
        moved = false;
        startClient = {x:evt.clientX, y:evt.clientY};
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      }
      function onMove(evt){
        if(!dragging) return;
        const d = Math.hypot(evt.clientX-startClient.x, evt.clientY-startClient.y);
        if(d > 3) moved = true;
        const yd = svgPoint(evt);
        yd.x = clamp(yd.x, FIELD_X[0]+0.5, FIELD_X[1]-0.5);
        yd.y = clamp(yd.y, FIELD_Y[0]+0.5, FIELD_Y[1]-0.5);
        // offensive players may not enter the crease
        const dGoal = dist(yd, GOAL);
        if(dGoal < CREASE_BUFFER){
          const dir = dGoal < 0.001 ? {x:0,y:1} : {x:(yd.x-GOAL.x)/dGoal, y:(yd.y-GOAL.y)/dGoal};
          yd.x = GOAL.x + dir.x*CREASE_BUFFER;
          yd.y = GOAL.y + dir.y*CREASE_BUFFER;
        }
        offense[idx] = yd;
        render();
      }
      function onUp(evt){
        dragging = false;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        if(!moved){
          trySelectBallIndex(idx);
        }
      }
      g.addEventListener('pointerdown', onDown);
    }

    function trySelectBallIndex(newIdx){
      if(newIdx === ballIndex){ ballIndex = newIdx; render(); return; }
      if(config.onPass) config.onPass(newIdx, offense, ballIndex, helpers);
      ballIndex = newIdx;
      render();
    }

    // ---------------- communication toggle ----------------
    const commToggleEl = document.getElementById('commToggle');
    if(commToggleEl){
      commToggleEl.addEventListener('change', render);
    }

    // ---------------- shot zone overlay toggle ----------------
    const shotZoneToggleEl = document.getElementById('shotZoneToggle');
    if(shotZoneToggleEl){
      shotZoneToggleEl.addEventListener('change', render);
    }

    // ---------------- attacker count controls ----------------
    function addAttacker(){
      offense.push({ x: (Math.random()*24-12), y: 6 + Math.random()*8 });
    }
    const addBtnEl = document.getElementById('addBtn');
    const removeBtnEl = document.getElementById('removeBtn');
    if(addBtnEl){
      addBtnEl.addEventListener('click', ()=>{
        const ac = config.attackerCount || {};
        if(!ac.adjustable) return;
        if(offense.length >= (ac.max || 6)) return;
        addAttacker();
        render();
      });
    }
    if(removeBtnEl){
      removeBtnEl.addEventListener('click', ()=>{
        const ac = config.attackerCount || {};
        if(!ac.adjustable) return;
        if(offense.length <= (ac.min || 2)) return;
        offense.pop();
        if(ballIndex >= offense.length) ballIndex = 0;
        render();
      });
    }

    // ---------------- reset ----------------
    const resetBtnEl = document.getElementById('resetBtn');
    function doReset(){
      offense = config.initialOffense.map(p => ({x:p.x, y:p.y}));
      ballIndex = config.initialBallIndex || 0;
      if(config.onReset) config.onReset(offense, ballIndex, helpers);
      render();
    }
    if(resetBtnEl){
      resetBtnEl.addEventListener('click', doReset);
    }

    // ---------------- boot ----------------
    buildField(staticLayer);
    if(config.onReset) config.onReset(offense, ballIndex, helpers);
    render();

    // ---------------- fit-to-container sizing ----------------
    const appEl = document.querySelector('.app-minimal');
    const cardEl = document.querySelector('.field-card');

    function fitField(){
      const padding = 16; // matches .app-minimal's 8px top + 8px bottom padding
      const gaps = 6;     // small safety buffer against rounding, not a real layout gap
      // Sum the height of every sibling of the SVG inside the card (title row,
      // toolbar row, hint text, controls, etc.) rather than hardcoding specific
      // elements - so this keeps working correctly as rows are added or removed,
      // instead of silently under-measuring and causing the SVG to be sized taller
      // than what actually fits (which then gets compressed by CSS, throwing off
      // the aspect ratio and making drag coordinates track inaccurately).
      let siblingsHeight = 0;
      Array.from(cardEl.children).forEach(child => {
        if(child === svg) return;
        const cs = getComputedStyle(child);
        siblingsHeight += child.offsetHeight + parseFloat(cs.marginTop || 0) + parseFloat(cs.marginBottom || 0);
      });
      const availableH = window.innerHeight - padding - siblingsHeight - gaps;
      const availableW = cardEl.clientWidth;

      const ratio = 880/760;
      let width = availableW;
      let height = width / ratio;
      if(height > availableH){
        height = Math.max(160, availableH);
        width = height * ratio;
      }
      svg.style.width = width + 'px';
      svg.style.height = height + 'px';
    }

    window.addEventListener('resize', fitField);
    window.addEventListener('load', fitField);
    if(document.fonts && document.fonts.ready){ document.fonts.ready.then(fitField); }
    if(window.ResizeObserver){ new ResizeObserver(fitField).observe(appEl); }
    fitField();

    return { render, reset: doReset };
  }

  window.DefenseEngine = { init, helpers };
})();
