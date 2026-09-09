export const tableFeatures=['Smoking','Non-smoking','Window side','Quiet area','Terrace','Near entrance','Far from entrance','Center','Outdoor','Booth','Accessible','High chair compatible','Near bar'];
// A template is always a draft: persistent table and QR identifiers are assigned by the server.
export function demoFloor(){
 const zone=(id,label,y,height,color)=>({id,type:'zone',label,x:600,y,width:1080,height,rotation:0,color});
 const layout={width:1200,height:800,schemaVersion:2,background:{image:null,opacity:.4,locked:true,x:0,y:0,width:1200,height:800},zones:[zone('demo-main','Main Room',280,450,'#e9e6dc'),zone('demo-terrace','Terrace',625,220,'#e0e9d7')],objects:[
 {id:'demo-wall',type:'wall',label:'North wall',x:600,y:40,width:1120,height:16,rotation:0},
 {id:'demo-window',type:'window',label:'Window side',x:800,y:52,width:550,height:12,rotation:0},
 {id:'demo-entry',type:'door',label:'Entrance',x:110,y:740,width:110,height:35,rotation:0},
 {id:'demo-bar',type:'counter',label:'Bar',x:1090,y:300,width:70,height:250,rotation:0},
 ...[180,600,1020].map((x,i)=>({id:'demo-plant-'+i,type:'plant',label:'Plant',x,y:495,width:42,height:42,rotation:0}))],tables:Array.from({length:12},(_,i)=>({id:'new-demo-'+(i+1),label:'T'+(i+1),capacity:i===3?6:4,shape:i%3===0?'round':'square',cx:230+((i===3?11:i===11?3:i===5?2:i===2?5:i===8?10:i===10?8:i)%4)*230,cy:160+Math.floor((i===3?11:i===11?3:i===5?2:i===2?5:i===8?10:i===10?8:i)/4)*220,width:100,height:100,rotation:0,zone:i===3||i>=8&&i!==11?'Terrace':'Main Room',reservable:true,minimumSpend:0,premium:i===5,features:i===5?['Non-smoking','Window side']:i===8?['Smoking','Quiet area','Far from entrance','Terrace']:i>=8&&i!==11||i===3?['Smoking','Terrace']:['Non-smoking','Center']}))};return layout;
}
