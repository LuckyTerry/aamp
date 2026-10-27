import {openSync,closeSync,readSync,statSync} from 'node:fs';
import {StringDecoder} from 'node:string_decoder';

// Read in bounded chunks; Windows has no native tail command.
export function followWindowsLogFiles(files,onLine,{intervalMs=200,onError=error=>console.error(error.message)}={}) {
  const cursors=files.map(file=>({file,position:statSync(file).size,decoder:new StringDecoder('utf8'),pending:''}));
  const timer=setInterval(()=>{
    for(const cursor of cursors) {
      let fd;
      try {
        const size=statSync(cursor.file).size;
        if(size<cursor.position) {cursor.position=0;cursor.decoder=new StringDecoder('utf8');cursor.pending='';}
        if(size===cursor.position) continue;
        fd=openSync(cursor.file,'r');
        // Process at most 64 KiB per tick per file so a large writer cannot monopolize the event loop.
        const buffer=Buffer.alloc(Math.min(65536,size-cursor.position));
        const count=readSync(fd,buffer,0,buffer.length,cursor.position);
        cursor.position+=count;
        cursor.pending+=cursor.decoder.write(buffer.subarray(0,count));
        const lines=cursor.pending.split(/\r?\n/);cursor.pending=lines.pop() ?? '';
        for(const line of lines) onLine(cursor.file,line);
      } catch(error) {if(error.code!=='ENOENT')onError(error);}
      finally {if(fd!==undefined)closeSync(fd);}
    }
  },intervalMs);
  return ()=>clearInterval(timer);
}
