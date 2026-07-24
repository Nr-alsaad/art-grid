import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = new URL(".", import.meta.url).pathname.replace(/^\/(.:\/)/, "$1");
const port = Number(process.env.PORT || 4173);
const types = {".html":"text/html; charset=utf-8",".css":"text/css; charset=utf-8",".js":"text/javascript; charset=utf-8",".json":"application/json; charset=utf-8",".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".webp":"image/webp"};

createServer(async (request,response)=>{
  try{
    const pathname=decodeURIComponent(new URL(request.url,"http://localhost").pathname);
    const relative=normalize(pathname==="/"?"index.html":pathname.replace(/^\/+/,""));
    if(relative.startsWith("..")){response.writeHead(403).end("Forbidden");return}
    const file=join(root,relative);if(!(await stat(file)).isFile())throw new Error("not-file");
    response.writeHead(200,{"Content-Type":types[extname(file).toLowerCase()]||"application/octet-stream","Cache-Control":"no-store"});
    response.end(await readFile(file));
  }catch{response.writeHead(404,{"Content-Type":"text/plain; charset=utf-8"});response.end("Not found")}
}).listen(port,"0.0.0.0",()=>console.log(`Art Grid: http://localhost:${port}`));
