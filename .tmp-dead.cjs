
const fs=require('fs'),path=require('path');
const files=[];const walk=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())walk(p);else if(/\.tsx?$/.test(e.name))files.push(p)}};
walk('src/renderer');
const src=files.map(f=>fs.readFileSync(f,'utf8')).join('\n');
const dead=['tnum','gauge-read','gauge-label','cache-badge','cache-dot','gauge-bar','side-top','st-run','spine-h','spine-list','flag','seal-source','composer-tools','tool-key','next-row','next-h','rule-h','pill-row','dot-sm','sheet-empty','tgroup-others','tg-goto','sealcard-empty','thread-panel','sf-member','report-preview','sheet-note','sf-team','sf-section','sf-row2','sf-foot','ui-plugin-list','ui-plugin-main','ui-plugin-set','ui-plugin-side','ui-plugin-slots','prewrap','talk-head','fv-role','wd-d','zero','next'];
for (const c of dead) {
  const re = new RegExp('(?<![\\w-])' + c.replace(/-/g,'\\-') + '(?![\\w-])');
  if (!re.test(src)) console.log('DEAD .' + c);
}
