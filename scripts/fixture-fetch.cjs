// Used only by the isolated integration test. Never preload in Vercel/start.
if (process.env.ROI_TEST_FIXTURE === '1') {
  // Blob SDK uses undici's fetch rather than global fetch. Redirect ONLY our
  // fictitious private store to the isolated local fixture; keep the real SDK.
  const undici=require('undici');
  const sdkFetch=undici.fetch;
  undici.fetch=async function(input,options) {
    const url=new URL(String(input));
    if(url.hostname==='qastore.private.blob.vercel-storage.com') {
      if(url.searchParams.get('cache')!=='0') throw new Error('QA requires latest uncached private reads');
      return sdkFetch(`${process.env.VERCEL_BLOB_API_URL}/read?pathname=${encodeURIComponent(url.pathname.replace(/^\//,''))}`,options);
    }
    return sdkFetch(input,options);
  };
  const original = globalThis.fetch;
  const map = {'roistation.example':'roistation','atlas-yapi.vercel.app':'atlas-yapi','kiyidis.example':'kiyi-dis','limantemizlik.example':'liman-temizlik','zeytinlik.example':'zeytinlik-restoran','konak-otel-rezervasyon.vercel.app':'konak-otel','mavi-koy-turizm.vercel.app':'mavi-koy-turizm','dengedanismanlik.example':'denge-danismanlik'};
  globalThis.fetch = async function(input, options) {
    const url=new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if(url.hostname==='qastore.private.blob.vercel-storage.com') return original(`${process.env.VERCEL_BLOB_API_URL}/read?pathname=${encodeURIComponent(url.pathname.replace(/^\//,''))}`,options);
    if(map[url.hostname]) {
      const siteId=map[url.hostname];const connected=['roistation','atlas-yapi'].includes(siteId);
      return new Response(connected ? `<html><div data-roistation-site="${siteId}"></div><script src="https://master.test/widget.js" defer></script></html>` : '<html><h1>No connector installed</h1></html>',{status:200,headers:{'content-type':'text/html'}});
    }
    return original(input, options);
  };
}
