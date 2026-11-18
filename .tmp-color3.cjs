
function hexToRgb(h){h=h.replace('#','');if(h.length===3)h=h.split('').map(c=>c+c).join('');return [0,2,4].map(i=>parseInt(h.slice(i,i+2),16));}
function L(h){const c=hexToRgb(h).map(v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);});return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2];}
function ratio(a,b){const la=L(a),lb=L(b);return (Math.max(la,lb)+0.05)/(Math.min(la,lb)+0.05);}
function mix(a,b,t){const A=hexToRgb(a),B=hexToRgb(b);return '#'+A.map((v,i)=>Math.round(v+(B[i]-v)*t).toString(16).padStart(2,'0')).join('');}
const darkBgs = ['#0a0d0f','#151d22','#1a2429','#212c33'];
const lightBgs = ['#ffffff','#f7f7f5','#f1f1ef'];
const minD = c => Math.min(...darkBgs.map(b=>ratio(c,b)));
const minL = c => Math.min(...lightBgs.map(b=>ratio(c,b)));

function findDark(base, target){ for(let t=0;t<=1;t+=0.005){ const c=mix(base,'#ffffff',t); if(minD(c)>=target) return c; } return null; }
function findLight(base, target){ for(let t=0;t<=1;t+=0.005){ const c=mix(base,'#000000',t); if(minL(c)>=target) return c; } return null; }

console.log('dark seal-text (from #c8443a):', findDark('#c8443a',4.6), minD(findDark('#c8443a',4.6)).toFixed(2));
console.log('dark brass-text (from #c9a227):', findDark('#c9a227',4.6), minD(findDark('#c9a227',4.6)).toFixed(2));
console.log('dark red-text (from #e0775f):', findDark('#e0775f',4.6), minD(findDark('#e0775f',4.6)).toFixed(2));
console.log('light brass-text (from #8a6f1e):', findLight('#8a6f1e',4.6), minL(findLight('#8a6f1e',4.6)).toFixed(2));
console.log('light red-text (from #b0453a):', minL('#b0453a').toFixed(2), 'ok');
console.log('light seal-text (from #b0402f):', minL('#b0402f').toFixed(2), 'ok');
console.log('dark blue-text (from #6fa892):', minD('#6fa892').toFixed(2), 'ok');
console.log('light blue-text (from #3e6f5b):', minL('#3e6f5b').toFixed(2), 'ok');
console.log('dark ink-3 #9ea8ae:', minD('#9ea8ae').toFixed(2), ' ink-4 #8f9a9f:', minD('#8f9a9f').toFixed(2));
console.log('light ink-3 #5c5a54:', minL('#5c5a54').toFixed(2), ' ink-4 #6b6a63:', minL('#6b6a63').toFixed(2));
