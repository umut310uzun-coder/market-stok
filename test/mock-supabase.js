// Sahte Supabase: arayüzü tarayıcıda denemek için
(function(){
const db = {
  profiles:[{id:'u1',full_name:'Umut',role:'admin',active:true,created_at:'2026-10-01'},{id:'u2',full_name:'eleman1',role:'staff',active:true,created_at:'2026-10-01'}],
  products:[
    {id:1,barcode:'8690504000011',name:'Ekmek',price:10,cost:7,stock:20,min_stock:5,unit:'adet',active:true,is_own_barcode:false,image_url:null,category:'Fırın'},
    {id:2,barcode:'8690504000028',name:'Süt 1L',price:35.5,cost:30,stock:6,min_stock:5,unit:'adet',active:true,is_own_barcode:false,image_url:null,category:'Süt'},
    {id:3,barcode:'2000000000015',name:'Kuruyemiş karışık',price:450,stock:0,min_stock:2,unit:'kg',active:true,is_own_barcode:true,image_url:null},
  ],
  supplier_codes:[{supplier_vkn:'1234567890',supplier_code:'SUT01',product_id:2,multiplier:12}],
  invoices:[], sales:[], sale_items:[], app_settings:[], stock_movements:[],
};
window.__db=db; window.__rpc=[];
let nid=100;
function q(table){
  const st={f:[],op:'select',single:false,maybe:false,rows:null,lim:null};
  const b={
    select(){return b}, order(){return b}, range(a,z){st.range=[a,z];return b}, limit(n){st.lim=n;return b},
    eq(k,v){st.f.push(r=>r[k]==v);return b}, in(k,vs){st.f.push(r=>vs.includes(r[k]));return b},
    gte(){return b}, lte(){return b},
    maybeSingle(){st.maybe=true;return b}, single(){st.single=true;return b},
    insert(r){st.op='insert';st.rows=[].concat(r);return b}, update(r){st.op='update';st.rows=r;return b},
    delete(){st.op='delete';return b}, upsert(r){st.op='upsert';st.rows=[].concat(r);return b},
    then(res,rej){ try{ res(run()) }catch(e){ rej(e) } }
  };
  function run(){
    const T=db[table]; let out;
    if(st.op==='insert'){ for(const r of st.rows){ if(table==='products'&&T.some(x=>x.barcode===r.barcode)) return {data:null,error:{code:'23505',message:'dup'}}; const n={id:++nid,stock:0,...r}; T.push(n); out=[n]; } }
    else if(st.op==='update'){ out=T.filter(r=>st.f.every(f=>f(r))); out.forEach(r=>Object.assign(r,st.rows)); }
    else if(st.op==='delete'){ const k=T.filter(r=>st.f.every(f=>f(r))); k.forEach(r=>T.splice(T.indexOf(r),1)); out=k; }
    else if(st.op==='upsert'){ for(const r of st.rows){ const e=T.find(x=>x.key===r.key); e?Object.assign(e,r):T.push(r);} out=st.rows; }
    else { out=T.filter(r=>st.f.every(f=>f(r))); if(st.range) out=out.slice(st.range[0],st.range[1]+1); if(st.lim) out=out.slice(0,st.lim);
      if(table==='sales') out=out.map(s=>({...s,sale_items:db.sale_items.filter(i=>i.sale_id===s.id).map(i=>({...i,products:db.products.find(p=>p.id===i.product_id)}))})); }
    out=JSON.parse(JSON.stringify(out));
    if(st.single||st.maybe) return {data:out[0]||null,error:null};
    return {data:out,error:null};
  }
  return b;
}
const rpc=async(name,a)=>{ window.__rpc.push([name,a]);
  if(name==='make_sale'){ let t=0; const id=++nid; for(const i of a.p_items){const p=db.products.find(x=>x.id===i.product_id); p.stock-=i.qty; t+=p.price*i.qty; db.sale_items.push({sale_id:id,product_id:p.id,qty:i.qty,unit_price:p.price,line_total:p.price*i.qty});} db.sales.push({id,created_at:new Date().toISOString(),total:t,payment:a.p_payment,cancelled:false,user_id:'u1'}); return {data:{sale_id:id,total:t,negative:[]},error:null}; }
  if(name==='daily_report') return {data:{tarih:a.p_date,ciro:db.sales.reduce((s,x)=>s+x.total,0),satis_adedi:db.sales.length,nakit:0,kart:0,en_cok_satan:[],azalan:db.products.filter(p=>p.stock<=p.min_stock).map(p=>({urun:p.name,stok:p.stock,min_stok:p.min_stock,birim:p.unit}))},error:null};
  if(name==='needs_setup') return {data:false,error:null};
  if(name==='create_user'){ db.profiles.push({id:'u'+(++nid),full_name:a.p_full_name,role:a.p_role,active:true}); return {data:'x',error:null}; }
  if(name==='import_products') return {data:{eklenen:a.p_rows.length,guncellenen:0},error:null};
  if(name==='next_own_barcode') return {data:'2000000000022',error:null};
  if(name==='set_stock'){ db.products.find(x=>x.id===a.p_product_id).stock=a.p_new_stock; return {data:a.p_new_stock,error:null}; }
  if(name==='apply_invoice'){ for(const l of a.p_lines){ db.products.find(x=>x.id===l.product_id).stock+=l.qty*l.multiplier; } return {data:1,error:null}; }
  return {data:null,error:null};
};
window.supabase={createClient:()=>({
  auth:{ getSession:async()=>({data:{session:{user:{id:'u1'}}}}), signInWithPassword:async()=>({data:{user:{id:'u1'}}}), signOut:async()=>({}) },
  from:q, rpc })};
window.Html5Qrcode=function(){}; window.Html5QrcodeSupportedFormats={};
window.JsBarcode=function(svg){svg.setAttribute('data-ok','1')};
window.MARKET_CONFIG={SUPABASE_URL:'https://x.supabase.co',SUPABASE_ANON_KEY:'x'.repeat(30),MARKET_NAME:'Uzun Market'};
})();
