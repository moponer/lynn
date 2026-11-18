
function hexToRgb(h){h=h.replace('#','');if(h.length===3)h=h.split('').map(c=>c+c).join('');return [0,2,4].map(i=>parseInt(h.slice(i,i+2),16));}
function L(h){const c=hexToRgb(h).map(v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);});return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2];}
function ratio(a,b){const la=L(a),lb=L(b);return (Math.max(la,lb)+0.05)/(Math.min(la,lb)+0.05);}
const darkBgs = ['#0a0d0f','#151d22','#1a2429','#212c33'];
const lightBgs = ['#ffffff','#f7f7f5','#f1f1ef'];
const minD = c => Math.min(...darkBgs.map(b=>ratio(c,b)));
const minL = c => Math.min(...lightBgs.map(b=>ratio(c,b)));
console.log('--- dark ink candidates (min over desk/sheet/sheet-3) ---');
for (const c of ['#e6ebee','#c8d0d4','#b4bdc2','#a8b2b8','#9ea8ae','#98a2a8','#8f9a9f','#8b959b']) console.log(c, minD(c).toFixed(2));
console.log('--- light ink candidates ---');
for (const c of ['#37352f','#4a4842','#55534c','#5c5a54','#63615a','#6b6a63','#706f68','#767570']) console.log(c, minL(c).toFixed(2));
console.log('--- dark: seal #d2564a on each surface ---');
for (const bg of darkBgs) console.log(bg, ratio('#d2564a',bg).toFixed(2));
console.log('--- light seal #b0402f ---');
for (const bg of lightBgs) console.log(bg, ratio('#b0402f',bg).toFixed(2));
console.log('--- dark brass #c9a227 ---');
for (const bg of darkBgs) console.log(bg, ratio('#c9a227',bg).toFixed(2));
console.log('--- dark red #e0775f ---');
for (const bg of darkBgs) console.log(bg, ratio('#e0775f',bg).toFixed(2));
console.log('--- light brass/red ---');
console.log('brass', minL('#8a6f1e').toFixed(2), 'red', minL('#b0453a').toFixed(2));
console.log('--- dark blue #6fa892 ---');
for (const bg of darkBgs) console.log(bg, ratio('#6fa892',bg).toFixed(2));
