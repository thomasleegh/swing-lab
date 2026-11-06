// Run the analysis core on a tracking dump and print a summary: node scripts/analyze.js <track.json>
const C = require('../js/core.js');
const o = require(require('path').resolve(process.argv[2]));
o.swings.forEach((sw, i) => {
  const a = C.analyzeSwing(sw, o.meta);
  if (!a.ok) { console.log(`swing ${i + 1}: FAIL ${a.reason}`); return; }
  const p = a.phases, f = (x) => x.toFixed(2);
  console.log(`swing ${i + 1}: ${a.view} ${a.handed} ballSide ${a.ballSide} approx ${a.approx} | addr ${f(p.address)} take ${f(p.takeaway)} p3 ${f(p.p3)} top ${f(p.top)} trans ${f(p.transition)} del ${f(p.delivery)} imp ${f(p.impact)} rel ${f(p.release)} fin ${f(p.finish)}`);
  console.log('   metrics', JSON.stringify(a.metrics));
  console.log('   fault', a.mainFault.label, '| stature', a.stature, '| club ang addr/top/imp', a.frames[a.idx.address].club.ang, a.frames[a.idx.top].club.ang, a.frames[a.idx.impact].club.ang);
});
