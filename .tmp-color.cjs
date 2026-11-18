
function hexToRgb(h){h=h.replace('#','');if(h.length===3)h=h.split('').map(c=>c+c).join('');return [0,2,4].map(i=>parseInt(h.slice(i,i+2),16));}
function L(h){const c=hexToRgb(h).map(v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);});return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2];}
function ratio(a,b){const la=L(a),lb=L(b);return (Math.max(la,lb)+0.05)/(Math.min(la,lb)+0.05);}
function mix(a,b,t){const A=hexToRgb(a),B=hexToRgb(b);return '#'+A.map((v,i)=>Math.round(v+(B[i]-v)*t).toString(16).padStart(2,'0')).join('');}

// 目标：暗色下 --seal 对 --sheet-3(#212c33) / --sheet-2(#1a2429) / --desk(#0a0d0f) 都 >= 4.5
const darks = ['#212c33','#1a2429','#151d22','#0e1215','#0a0d0f'];
function findSeal(base, target=4.55){
  for(let t=0;t<=1;t+=0.005){
    const c=mix(base,'#ffffff',t);
    if(darks.every(bg=>ratio(c,bg)>=target)) return {c,t:t.toFixed(3),min:Math.min(...darks.map(bg=>ratio(c,bg))).toFixed(2)};
  }
  return null;
}
console.log('seal dark from #c8443a:', JSON.stringify(findSeal('#c8443a')));
console.log('seal dark from #d2564a:', JSON.stringify(findSeal('#d2564a')));
console.log('seal dark from #d95c4e:', JSON.stringify(findSeal('#d95c4e')));

// 墨色四级：暗色 --ink-3 / --ink-4 需在 --sheet-3 上仍 >= 4.5，且彼此有明显差
const inkTargets = ['#0a0d0f','#151d22','#1a2429','#212c33'];
function checkInk(c){ return Math.min(...inkTargets.map(bg=>ratio(c,bg))).toFixed(2); }
for (const c of ['#e6ebee','#a3adb3','#8b959b','#8a949a','#7f8a90','#6e7a80','#66717a']) {
  console.log('ink', c, 'min-ratio', checkInk(c));
}
// 亮色
const lightBgs = ['#ffffff','#f7f7f5','#f1f1ef'];
for (const c of ['#37352f','#5c5a54','#6b6a63','#67665f','#85847c','#8a8983']) {
  console.log('light ink', c, 'min-ratio', Math.min(...lightBgs.map(bg=>ratio(c,bg))).toFixed(2));
}
console.log('light seal #b0402f on #f1f1ef', ratio('#b0402f','#f1f1ef').toFixed(2));
console.log('light blue #3e6f5b on #ffffff', ratio('#3e6f5b','#ffffff').toFixed(2));
console.log('light brass #8a6f1e on #ffffff', ratio('#8a6f1e','#ffffff').toFixed(2));
// hover 态：--blue-hover
console.log('dark blue-hover #7fb8a3, on-accent #0a0d0f =', ratio('#0a0d0f','#7fb8a3').toFixed(2));
console.log('light blue-hover #35604f, on-accent #ffffff =', ratio('#ffffff','#35604f').toFixed(2));
