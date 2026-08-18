function rng(seed){let s=seed>>>0;return()=>(s=(s*1103515245+12345)&0x7fffffff)/0x7fffffff;}
function makeNative(n,seed,blocky){const rnd=rng(seed);const pal=Array.from({length:8},()=>[Math.floor(rnd()*255),Math.floor(rnd()*255),Math.floor(rnd()*255)]);
const d=new Uint8ClampedArray(n*n*4);const grid=new Int32Array(n*n);
for(let y=0;y<n;y++)for(let x=0;x<n;x++){let c;if(blocky&&x>0&&rnd()<0.55)c=grid[y*n+x-1];else if(blocky&&y>0&&rnd()<0.45)c=grid[(y-1)*n+x];else c=Math.floor(rnd()*8);grid[y*n+x]=c;
const p=(y*n+x)*4,edge=x<2||y<2||x>=n-2||y>=n-2;if(edge&&rnd()<0.6){d[p+3]=0;continue;}d[p]=pal[c][0];d[p+1]=pal[c][1];d[p+2]=pal[c][2];d[p+3]=255;}
return{w:n,h:n,rgba:d,grid};}
function upscale(src,f,smooth){const W=Math.round(src.w*f),H=Math.round(src.h*f);const out=new Uint8ClampedArray(W*H*4);
for(let y=0;y<H;y++)for(let x=0;x<W;x++){const sx=(x+0.5)/f-0.5,sy=(y+0.5)/f-0.5,o=(y*W+x)*4;
if(!smooth){const ix=Math.min(src.w-1,Math.max(0,Math.round(sx))),iy=Math.min(src.h-1,Math.max(0,Math.round(sy)));const p=(iy*src.w+ix)*4;out[o]=src.rgba[p];out[o+1]=src.rgba[p+1];out[o+2]=src.rgba[p+2];out[o+3]=src.rgba[p+3];}
else{const x0=Math.floor(sx),y0=Math.floor(sy),tx=sx-x0,ty=sy-y0;for(let c=0;c<4;c++){let v=0;for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++){const ix=Math.min(src.w-1,Math.max(0,x0+dx)),iy=Math.min(src.h-1,Math.max(0,y0+dy));v+=src.rgba[(iy*src.w+ix)*4+c]*(dx?tx:1-tx)*(dy?ty:1-ty);}out[o+c]=v;}}}
return{w:W,h:H,rgba:out};}
function blurImg(img,r){if(!r)return img;const{w,h}=img;let src=img.rgba;for(let pass=0;pass<2;pass++){const tmp=new Uint8ClampedArray(src.length);
for(let y=0;y<h;y++)for(let x=0;x<w;x++)for(let c=0;c<4;c++){let sum=0,n=0;for(let d=-r;d<=r;d++){const xx=pass?x:Math.min(w-1,Math.max(0,x+d)),yy=pass?Math.min(h-1,Math.max(0,y+d)):y;sum+=src[(yy*w+xx)*4+c];n++;}tmp[(y*w+x)*4+c]=sum/n;}src=tmp;}return{w,h,rgba:src};}
const CASES=[];for(const blocky of[false,true])for(const[n,f,blur,smooth]of[[24,4,0,false],[24,8,0,false],[24,16,0,false],[32,7,0,false],[32,11,0,false],[24,16,1,false],[24,16,2,false],[24,13.7,0,true],[32,21.3,0,true],[24,26.7,1,true],[32,9.5,0,true],[24,6.3,0,true]])CASES.push({n,f,blur,smooth,blocky});
module.exports={makeNative,upscale,blurImg,CASES};
