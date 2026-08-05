(function(root, factory){
  const api = factory();
  if(typeof module !== "undefined" && module.exports) module.exports = api;
  if(root) root.CrolExports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function(){
  "use strict";

  const encoder = new TextEncoder();
  const xmlEscape = value => String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  const csvEscape = value => `"${String(value == null ? "" : value).replace(/"/g, '""')}"`;
  const columnLabel = column => Array.isArray(column) ? column[0] : column.label;
  const columnValue = (column, row) => (Array.isArray(column) ? column[1] : column.value)(row);

  function excelSafeCsv(columns, rows){
    const lines = [columns.map(column => csvEscape(columnLabel(column))).join(",")];
    rows.forEach(row => lines.push(columns.map(column => csvEscape(columnValue(column, row))).join(",")));
    return "\uFEFF" + lines.join("\r\n");
  }

  function downloadFile(name, content, type){
    const blob = content instanceof Blob ? content : new Blob([content], {type});
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  const crcTable = new Uint32Array(256);
  for(let n=0; n<256; n++){
    let value=n;
    for(let k=0; k<8; k++) value=(value&1) ? (0xedb88320^(value>>>1)) : (value>>>1);
    crcTable[n]=value>>>0;
  }
  function crc32(data){
    let crc=0xffffffff;
    for(const byte of data) crc=crcTable[(crc^byte)&0xff]^(crc>>>8);
    return (crc^0xffffffff)>>>0;
  }
  const u16 = value => [value&255, (value>>>8)&255];
  const u32 = value => [value&255, (value>>>8)&255, (value>>>16)&255, (value>>>24)&255];
  function concatBytes(parts){
    const size=parts.reduce((total, part)=>total+part.length,0);
    const out=new Uint8Array(size);
    let offset=0;
    parts.forEach(part=>{ out.set(part,offset); offset+=part.length; });
    return out;
  }
  function zipStore(files){
    const localParts=[], centralParts=[];
    let offset=0;
    files.forEach(file=>{
      const name=encoder.encode(file.name), data=typeof file.data==="string"?encoder.encode(file.data):file.data;
      const checksum=crc32(data), size=data.length;
      const local=new Uint8Array([
        ...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0),
        ...u32(checksum), ...u32(size), ...u32(size), ...u16(name.length), ...u16(0),
      ]);
      localParts.push(local,name,data);
      const central=new Uint8Array([
        ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0),
        ...u32(checksum), ...u32(size), ...u32(size), ...u16(name.length), ...u16(0), ...u16(0),
        ...u16(0), ...u16(0), ...u32(0), ...u32(offset),
      ]);
      centralParts.push(central,name);
      offset+=local.length+name.length+data.length;
    });
    const central=concatBytes(centralParts);
    const end=new Uint8Array([
      ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length),
      ...u32(central.length), ...u32(offset), ...u16(0),
    ]);
    return concatBytes([...localParts,central,end]);
  }

  function excelDate(value){
    if(!value) return null;
    const text=String(value);
    const wall=text.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):?(\d{2})?:?(\d{2})?)?/);
    if(wall){
      const serial=Date.UTC(+wall[1],+wall[2]-1,+wall[3],+(wall[4]||0),+(wall[5]||0),+(wall[6]||0))/86400000+25569;
      return Number.isFinite(serial)?serial:null;
    }
    const date=new Date(text);
    return Number.isFinite(date.getTime()) ? date.getTime()/86400000+25569 : null;
  }
  function columnName(index){
    let name="";
    for(let value=index+1; value; value=Math.floor((value-1)/26)) name=String.fromCharCode(65+(value-1)%26)+name;
    return name;
  }
  function inlineCell(ref, value, style){
    return `<c r="${ref}" t="inlineStr"${style==null?"":` s="${style}"`}><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
  }
  function dataCell(ref, value, type){
    if(type==="number"){
      const number=Number(value);
      return Number.isFinite(number) && value!=="" && value!=null ? `<c r="${ref}"><v>${number}</v></c>` : inlineCell(ref,"");
    }
    if(type==="date"||type==="datetime"){
      const serial=excelDate(value);
      return serial==null ? inlineCell(ref,"") : `<c r="${ref}" s="${type==="datetime"?3:1}"><v>${serial}</v></c>`;
    }
    return inlineCell(ref,value);
  }
  function worksheetXml(columns, rows){
    const cols=columns.map((column,index)=>{
      const width=Math.max(8,Math.min(60,Number(column.width)||16));
      return `<col min="${index+1}" max="${index+1}" width="${width}" customWidth="1"/>`;
    }).join("");
    const header=columns.map((column,index)=>inlineCell(`${columnName(index)}1`,column.label,2)).join("");
    const body=rows.map((row,rowIndex)=>{
      const cells=columns.map((column,columnIndex)=>
        dataCell(`${columnName(columnIndex)}${rowIndex+2}`,row[column.key],column.type)
      ).join("");
      return `<row r="${rowIndex+2}">${cells}</row>`;
    }).join("");
    const lastColumn=columnName(Math.max(0,columns.length-1));
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:${lastColumn}${Math.max(1,rows.length+1)}"/>
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  <cols>${cols}</cols>
  <sheetData><row r="1">${header}</row>${body}</sheetData>
  <autoFilter ref="A1:${lastColumn}${Math.max(1,rows.length+1)}"/>
</worksheet>`;
  }
  function safeSheetName(value){
    return String(value||"Sheet").replace(/[\\/*?:[\]]/g," ").slice(0,31)||"Sheet";
  }
  function workbookBytes(sheets){
    const workbookSheets=sheets.map((sheet,index)=>
      `<sheet name="${xmlEscape(safeSheetName(sheet.name))}" sheetId="${index+1}" r:id="rId${index+1}"/>`
    ).join("");
    const relationships=sheets.map((sheet,index)=>
      `<Relationship Id="rId${index+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index+1}.xml"/>`
    ).join("");
    const overrides=sheets.map((sheet,index)=>
      `<Override PartName="/xl/worksheets/sheet${index+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    ).join("");
    const files=[
      {name:"[Content_Types].xml",data:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  ${overrides}
</Types>`},
      {name:"_rels/.rels",data:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`},
      {name:"xl/workbook.xml",data:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>${workbookSheets}</sheets>
</workbook>`},
      {name:"xl/_rels/workbook.xml.rels",data:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${relationships}
  <Relationship Id="rId${sheets.length+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`},
      {name:"xl/styles.xml",data:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm"/></numFmts>
  <fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="4">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"><alignment wrapText="1"/></xf>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`},
    ];
    sheets.forEach((sheet,index)=>files.push({
      name:`xl/worksheets/sheet${index+1}.xml`,
      data:worksheetXml(sheet.columns,sheet.rows),
    }));
    return zipStore(files);
  }

  const EXPORT_CLASS_POLICY = Object.freeze({
    plain_summary:{sheets:["Notice","Records"]},
    notice_context:{sheets:["Notice","Records","Rendered context"]},
    actions:{sheets:["Actions"]},
    address_geography:{sheets:["Notice","Records","Entities"]},
    mwbe_context:{sheets:["Notice","Records","Rendered context"]},
    rule_lifecycle:{sheets:["Timed events","Actions","Lifecycle","Sources"]},
    procurement_lifecycle:{sheets:["Timed events","Actions","Lifecycle","Sources"]},
    award_registration_dwell:{sheets:["Lifecycle","Rendered context"]},
    sub_outreach:{sheets:["Actions","Rendered context"]},
    dollars:{sheets:["Lifecycle","Rendered context"]},
    subsidy:{sheets:["Timed events","Lifecycle","Entities","Sources"]},
    authority_award:{sheets:["Lifecycle","Entities","Sources"]},
    commercial:{sheets:["Notice","Records","Timed events","Actions"]},
    property_disposition:{sheets:["Timed events","Lifecycle"]},
    property_cross_domain:{sheets:["Entities","Sources"]},
    tax_lien:{sheets:["Timed events","Actions","Lifecycle"]},
    franchise:{sheets:["Timed events","Lifecycle","Entities","Sources"]},
    land_project:{sheets:["Timed events","Lifecycle","Entities","Sources"]},
    meeting_outcomes:{sheets:["Timed events","Actions","Lifecycle","Sources"]},
    external_award:{sheets:["Lifecycle","Entities","Sources"]},
    paper_trail:{sheets:["Lifecycle","Sources"]},
    agency_forecast:{sheets:["Lifecycle","Rendered context"]},
    exam_identity:{sheets:["Exam"]},
    exam_facts:{sheets:["Exam"]},
    exam_prediction:{sheets:["Exam","Rendered context"]},
    exam_disclaimer:{sheets:["Rendered context"]},
    exam_process:{sheets:["Lifecycle","Sources"]},
    exam_outcomes:{sheets:["Lifecycle","Sources"]},
    exam_actions:{sheets:["Actions"]},
    exam_provenance:{sheets:["Sources"]},
    official_notice_text:{sheets:["Rendered context"]},
    unofficial_translation:{excluded:"Unofficial translations are intentionally omitted; the official English record remains in the export."},
  });

  const asArray=value=>Array.isArray(value)?value:(value==null||value===""?[]:[value]);
  const compact=value=>String(value==null?"":value).replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim();
  const joined=value=>asArray(value).map(item=>compact(item&&typeof item==="object"?(item.label||item.name||item.id||""):item)).filter(Boolean).join(" | ");
  const finite=value=>value!==""&&value!=null&&Number.isFinite(Number(value))?Number(value):"";
  const firstValue=(...values)=>{
    const found=values.find(value=>{
      if(value==null||value==="") return false;
      if(Array.isArray(value)) return value.length>0;
      return true;
    });
    return found===undefined?"":found;
  };
  const requestUrl=id=>id?`https://a856-cityrecord.nyc.gov/RequestDetail/${encodeURIComponent(id)}`:"";
  const itemUrl=(kind,id)=>{
    if(!id) return "";
    if(kind==="land") return `https://cityscroll.org/#land?project=${encodeURIComponent(id)}`;
    if(kind==="exam") return `https://cityscroll.org/exams/${encodeURIComponent(id)}/`;
    return `https://cityscroll.org/notices/${encodeURIComponent(id)}`;
  };
  function locationFor(row){
    return row.property_location||row._location||row.location||row.place||{};
  }
  function addressValues(location){
    return asArray(location.addresses).map(item=>typeof item==="string"?item:item&&item.label).filter(Boolean);
  }
  function locationCoordinate(location,key){
    const geometry=location.geometry||{};
    const address=asArray(location.addresses).find(item=>item&&item[key]!=null)||{};
    return finite(firstValue(geometry[key],location[key],address[key]));
  }
  function plainSummary(row){
    const summary=row.plain_summary||row._plain_summary||row.property_plain_summary||{};
    return compact(firstValue(
      typeof summary==="string"?summary:"",
      summary.text,summary.summary,summary.lead,summary.headline,
      row.plain_language_summary,row.card_summary,row.summary
    ));
  }
  function primaryPrice(row){
    const commercial=row.commercial||{};
    const price=commercial.primary_price||(commercial.glance&&commercial.glance.price)||{};
    return finite(firstValue(price.amount,row.price_amount));
  }
  function recordRow(row, options){
    options=options||{};
    const location=locationFor(row);
    const commercial=row.commercial||{};
    const context=options.context||{};
    const id=firstValue(row.request_id,row.project_id,row.id);
    const kind=firstValue(row.kind,options.kind,row.project_id?"land":"notice");
    const permalink=typeof options.permalinkFor==="function"
      ? options.permalinkFor(row)
      : firstValue(row.permalink,itemUrl(kind,id));
    const cityRecord=typeof options.cityRecordFor==="function"
      ? options.cityRecordFor(row)
      : firstValue(row.city_record_url,row.request_id?requestUrl(row.request_id):"");
    const project=row.project_identity||row.project||{};
    const commercialItem=(commercial.glance&&commercial.glance.item)||(commercial.item&&commercial.item.label)||"";
    const price=commercial.primary_price||(commercial.glance&&commercial.glance.price)||{};
    return {
      request_id:compact(row.request_id),
      record_kind:compact(kind),
      type:compact(firstValue(row.type_of_notice_description,row.type,row.kind)),
      section:compact(row.section_name),
      category:compact(firstValue(row.category_description,row.category)),
      agency:compact(firstValue(row.agency_name,row.agency)),
      title:compact(firstValue(row.short_title,row.project_name,row.title,row.role)),
      plain_language_summary:plainSummary(row),
      posted_at:firstValue(row.start_date,row.published_at,row.posted),
      due_at:firstValue(row.due_date,row.close_date,commercial.close_date),
      event_at:firstValue(row.event_date,row.current_milestone_date),
      lifecycle_stage:compact(firstValue(row.disposition_stage,row.current_milestone,row._stage,row.process_stage)),
      amount:finite(firstValue(row.contract_amount,row.amount,primaryPrice(row))),
      pin:compact(row.pin),
      vendor:compact(firstValue(row.vendor_name,row.vendor)),
      selection_method:compact(firstValue(row.selection_method_description,row.procurement_method)),
      contact_name:compact(row.contact_name),
      contact_email:compact(firstValue(row.email,row.contact_email)),
      contact_phone:compact(row.contact_phone),
      submit_or_request_to:compact(firstValue(row.address_to_request,row.street_address_1)),
      action_url:compact(firstValue(context.primary_action_url,row.action_url,commercial.participation&&commercial.participation.package_url)),
      boroughs:joined(firstValue(location.boroughs,row.borough)),
      community_districts:joined(firstValue(location.community_districts,location.community_district,row.community_district,row.cd)),
      council_districts:joined(firstValue(location.council_districts,location.council_district,row.council_district,row.council)),
      neighborhoods:joined(firstValue(location.neighborhoods,row.neighborhood)),
      addresses:addressValues(location).join(" | ")||compact(row.street_address_1),
      latitude:locationCoordinate(location,"latitude"),
      longitude:locationCoordinate(location,"longitude"),
      bbls:joined(firstValue(location.bbls,row.bbls,row.bbl,row._property_bbl)),
      project_id:compact(firstValue(row.project_id,project.project_id,project.id)),
      project_name:compact(firstValue(row.project_name,project.project_name,project.name)),
      asset_type:compact(firstValue(row._asset,commercial.item&&commercial.item.category)),
      commercial_item:compact(commercialItem),
      price_amount:primaryPrice(row),
      price_kind:compact(price.kind),
      sale_method:compact(commercial.sale_method&&commercial.sale_method.method),
      permalink:compact(permalink),
      city_record_url:compact(cityRecord),
    };
  }

  const RECORD_COLUMNS=[
    {label:"Request ID",key:"request_id",type:"string",width:18},
    {label:"Record kind",key:"record_kind",type:"string",width:14},
    {label:"Type",key:"type",type:"string",width:22},
    {label:"Section",key:"section",type:"string",width:24},
    {label:"Category",key:"category",type:"string",width:28},
    {label:"Agency",key:"agency",type:"string",width:32},
    {label:"Title",key:"title",type:"string",width:48},
    {label:"Plain-language summary",key:"plain_language_summary",type:"string",width:60},
    {label:"Posted",key:"posted_at",type:"datetime",width:18},
    {label:"Due",key:"due_at",type:"datetime",width:18},
    {label:"Event date",key:"event_at",type:"datetime",width:18},
    {label:"Lifecycle stage",key:"lifecycle_stage",type:"string",width:22},
    {label:"Amount",key:"amount",type:"number",width:16},
    {label:"PIN",key:"pin",type:"string",width:20},
    {label:"Vendor",key:"vendor",type:"string",width:32},
    {label:"Selection method",key:"selection_method",type:"string",width:28},
    {label:"Contact",key:"contact_name",type:"string",width:24},
    {label:"Email",key:"contact_email",type:"string",width:32},
    {label:"Phone",key:"contact_phone",type:"string",width:20},
    {label:"Submit / request to",key:"submit_or_request_to",type:"string",width:44},
    {label:"Primary action URL",key:"action_url",type:"string",width:52},
    {label:"Boroughs",key:"boroughs",type:"string",width:18},
    {label:"Community districts",key:"community_districts",type:"string",width:20},
    {label:"Council districts",key:"council_districts",type:"string",width:18},
    {label:"Neighborhoods",key:"neighborhoods",type:"string",width:28},
    {label:"Addresses",key:"addresses",type:"string",width:48},
    {label:"Latitude",key:"latitude",type:"number",width:14},
    {label:"Longitude",key:"longitude",type:"number",width:14},
    {label:"BBLs",key:"bbls",type:"string",width:26},
    {label:"Project ID",key:"project_id",type:"string",width:20},
    {label:"Project name",key:"project_name",type:"string",width:36},
    {label:"Asset type",key:"asset_type",type:"string",width:20},
    {label:"Commercial item",key:"commercial_item",type:"string",width:36},
    {label:"Price",key:"price_amount",type:"number",width:16},
    {label:"Price kind",key:"price_kind",type:"string",width:18},
    {label:"Sale method",key:"sale_method",type:"string",width:20},
    {label:"Permalink",key:"permalink",type:"string",width:52},
    {label:"City Record URL",key:"city_record_url",type:"string",width:52},
  ];
  const EVENT_COLUMNS=[
    {label:"Request ID",key:"request_id",width:18},{label:"Event type",key:"event_type",width:24},
    {label:"Event date/time",key:"event_at",type:"datetime",width:20},{label:"Status",key:"status",width:18},
    {label:"Label",key:"label",width:48},{label:"Source URL",key:"source_url",width:52},
  ];
  const ACTION_COLUMNS=[
    {label:"Request ID",key:"request_id",width:18},{label:"Action type",key:"action_type",width:22},
    {label:"Action",key:"label",width:48},{label:"How to / destination",key:"destination",width:52},
    {label:"Delivery",key:"delivery",width:20},{label:"Deadline",key:"deadline",type:"datetime",width:20},
  ];
  const LIFECYCLE_COLUMNS=[
    {label:"Request ID",key:"request_id",width:18},{label:"Lifecycle",key:"lifecycle",width:24},
    {label:"Stage",key:"stage",width:24},{label:"Date",key:"event_at",type:"datetime",width:20},
    {label:"Status",key:"status",width:18},{label:"Amount",key:"amount",type:"number",width:16},
    {label:"Vendor / counterparty",key:"vendor",width:32},{label:"Detail",key:"detail",width:60},
    {label:"Source URL",key:"source_url",width:52},
  ];
  const ENTITY_COLUMNS=[
    {label:"Request ID",key:"request_id",width:18},{label:"Entity type",key:"entity_type",width:20},
    {label:"Name / identifier",key:"name",width:36},{label:"Relationship",key:"relationship",width:28},
    {label:"Entity URL",key:"url",width:52},{label:"Evidence",key:"evidence",width:48},
  ];
  const SOURCE_COLUMNS=[
    {label:"Request ID",key:"request_id",width:18},{label:"Source class",key:"source_class",width:22},
    {label:"Source label",key:"label",width:36},{label:"URL",key:"url",width:60},
  ];
  const CONTEXT_COLUMNS=[
    {label:"Request ID",key:"request_id",width:18},{label:"Rendered data class",key:"data_class",width:28},
    {label:"Visible context",key:"text",width:80},{label:"Links",key:"links",width:80},
  ];
  function uniqueRows(rows, keyFor){
    const seen=new Set();
    return rows.filter(row=>{const key=keyFor(row);if(seen.has(key))return false;seen.add(key);return true;});
  }
  function eventRows(row, context){
    const id=compact(row.request_id||row.project_id||row.id);
    const rows=[];
    const add=(event_type,event_at,label,status,source_url)=>{
      if(!event_at) return;
      rows.push({request_id:id,event_type:compact(event_type),event_at,label:compact(label),status:compact(status),source_url:compact(source_url)});
    };
    add("published",row.start_date||row.published_at,"Published","recorded",requestUrl(row.request_id));
    add("deadline",row.due_date,"Responses due","scheduled",requestUrl(row.request_id));
    add("event",row.event_date,"Public event","scheduled",requestUrl(row.request_id));
    add("milestone",row.current_milestone_date,row.current_milestone,"recorded",row.permalink);
    const commercial=row.commercial||{};
    asArray(commercial.timed_events).forEach(event=>add(event.kind||event.type,event.date||event.at,event.label||event.source_kind,event.status,event.url));
    asArray(context&&context.timed_events).forEach(event=>add(event.event_type||event.type,event.event_at||event.date,event.label,event.status,event.source_url||event.url));
    return uniqueRows(rows,item=>[item.event_type,item.event_at,item.label].join("|"));
  }
  function actionRows(row, context){
    const id=compact(row.request_id||row.project_id||row.id);
    const raw=[...asArray(row.property_reader_actions),...asArray(context&&context.actions)];
    return uniqueRows(raw.map(action=>({
      request_id:id,
      action_type:compact(action.type||action.kind),
      label:compact(action.label||action.title||action.text),
      destination:compact(action.destination||action.url||action.href||action.how_to),
      delivery:compact(action.delivery||action.destination_label),
      deadline:firstValue(action.deadline,action.due_at,action.date),
    })).filter(action=>action.label||action.destination),action=>[action.action_type,action.label,action.destination].join("|"));
  }
  function lifecycleRows(row, context, trail){
    const id=compact(row.request_id||row.project_id||row.id);
    const rows=[];
    const add=(entry,lifecycle)=>{
      const detail=entry&&entry.detail||{};
      rows.push({
        request_id:compact(firstValue(entry.request_id,id)),lifecycle:compact(lifecycle),stage:compact(entry.stage||entry.type||entry.kind||entry.type_of_notice_description),
        event_at:firstValue(entry.date,entry.event_at,entry.start_date,detail.date,detail.start_date),
        status:compact(entry.status),amount:finite(firstValue(entry.amount,entry.contract_amount,detail.amount,detail.current_amount,detail.total_spent)),
        vendor:compact(firstValue(entry.vendor,entry.vendor_name,detail.vendor,detail.vendor_name)),
        detail:compact(firstValue(entry.label,entry.text,entry.short_title,detail.title,detail.description)),
        source_url:compact(firstValue(entry.source_url,entry.url,entry.permalink,entry.request_id?requestUrl(entry.request_id):"")),
      });
    };
    asArray(trail).forEach(entry=>add(entry,"City Record paper trail"));
    const lifecycle=context&&context.lifecycle||row.lifecycle||row.contract_lifecycle||{};
    asArray(lifecycle.timeline||lifecycle).forEach(entry=>add(entry,"Procurement lifecycle"));
    const subsidy=context&&context.subsidy||row.subsidy_lifecycle||{};
    asArray(subsidy.timeline||subsidy).forEach(entry=>add(entry,"Subsidy lifecycle"));
    asArray(row.disposition_spine&&row.disposition_spine.events).forEach(entry=>add(entry,"Property disposition"));
    asArray(context&&context.lifecycle_rows).forEach(entry=>add(entry,entry.lifecycle||"Rendered lifecycle"));
    return uniqueRows(rows.filter(entry=>entry.stage||entry.detail),entry=>[entry.lifecycle,entry.stage,entry.event_at,entry.detail].join("|"));
  }
  function entityRows(row, context){
    const rec=recordRow(row,{context});
    const rows=[];
    const add=(entity_type,name,relationship,url,evidence)=>{if(name)rows.push({request_id:rec.request_id,entity_type,name:compact(name),relationship,url:compact(url),evidence:compact(evidence)});};
    const entityUrl=(kind,name)=>{
      if(!name)return "";
      const pivots=typeof globalThis!=="undefined"&&globalThis.CrolEntityPivots;
      if(pivots)return new URL(pivots.entityHref({ref:pivots.entityRouteRef(kind,name),label:name}),"https://cityscroll.org").href;
      if(kind==="agency")return `https://cityscroll.org/agencies/${encodeURIComponent(String(name).toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,""))}/`;
      return `https://cityscroll.org/vendors/${encodeURIComponent(String(name).toUpperCase().replace(/\s+(?:LLC|INC|CORP(?:ORATION)?|LTD)\.?$/,""))}/`;
    };
    add("agency",rec.agency,"published by",entityUrl("agency",rec.agency),"City Record agency field");
    add("vendor",rec.vendor,"awarded to",entityUrl("vendor",rec.vendor),"City Record or joined award field");
    add("project",rec.project_id||rec.project_name,"joined project",rec.project_id?`https://cityscroll.org/#land?project=${encodeURIComponent(rec.project_id)}`:"","exact published project identifier");
    rec.bbls.split(" | ").filter(Boolean).forEach(bbl=>add("parcel",bbl,"located on",/^\d{10}$/.test(bbl)?`https://zola.planning.nyc.gov/l/lot/${bbl[0]}/${Number(bbl.slice(1,6))}/${Number(bbl.slice(6))}`:"","published or exact-derived BBL"));
    asArray(context&&context.entities).forEach(entity=>add(entity.entity_type||entity.type,entity.name||entity.id,entity.relationship,entity.url,entity.evidence));
    return uniqueRows(rows,entry=>[entry.entity_type,entry.name,entry.relationship].join("|"));
  }
  function sourceRows(row, context, options){
    const rec=recordRow(row,{...(options||{}),context});
    const rows=[];
    const add=(source_class,label,url)=>{if(url)rows.push({request_id:rec.request_id,source_class,label:compact(label),url:compact(url)});};
    add("canonical","CityScroll permalink",rec.permalink);
    add("official","NYC City Record",rec.city_record_url);
    asArray(context&&context.sources).forEach(source=>add(source.source_class||source.type||"joined",source.label||source.text,source.url||source.href));
    return uniqueRows(rows,entry=>entry.url);
  }
  function contextRows(row, context){
    const id=compact(row.request_id||row.project_id||row.id);
    return asArray(context&&context.rendered_context).filter(item=>{
      const policy=EXPORT_CLASS_POLICY[item.data_class];
      return !policy||!policy.excluded;
    }).map(item=>({request_id:id,data_class:compact(item.data_class),text:compact(item.text).slice(0,32000),links:joined(item.links).slice(0,32000)}));
  }
  function exportModel(rows, options){
    options=options||{};
    const records=[],events=[],actions=[],lifecycle=[],entities=[],sources=[],contexts=[];
    asArray(rows).forEach((row,index)=>{
      const context=typeof options.contextFor==="function"?(options.contextFor(row,index)||{}):(options.context||{});
      const rowOptions={...options,context};
      records.push(recordRow(row,rowOptions));
      events.push(...eventRows(row,context));
      actions.push(...actionRows(row,context));
      lifecycle.push(...lifecycleRows(row,context,index===0?options.trail:null));
      entities.push(...entityRows(row,context));
      sources.push(...sourceRows(row,context,rowOptions));
      contexts.push(...contextRows(row,context));
    });
    return {records,events,actions,lifecycle,entities,sources,contexts};
  }
  function tabularSheet(sheetName, columns, rows){
    const workbookColumns=columns.map((column,index)=>{
      const source=Array.isArray(column) ? {label:column[0],value:column[1]} : column;
      return {
        label:source.label,
        key:`column_${index}`,
        type:source.type||"string",
        width:source.width||16,
        value:source.xlsxValue||source.value,
      };
    });
    const workbookRows=(rows||[]).map(row=>{
      const output={};
      workbookColumns.forEach(column=>{ output[column.key]=column.value(row); });
      return output;
    });
    return {name:sheetName,columns:workbookColumns,rows:workbookRows};
  }
  function enrichedSheets(firstSheetName, rows, options){
    options=options||{};
    const model=exportModel(rows,options);
    return [
      options.primaryColumns
        ? tabularSheet(firstSheetName,options.primaryColumns,rows)
        : {name:firstSheetName,columns:RECORD_COLUMNS,rows:model.records},
      {name:"Timed events",columns:EVENT_COLUMNS,rows:model.events},
      {name:"Actions",columns:ACTION_COLUMNS,rows:model.actions},
      {name:"Lifecycle",columns:LIFECYCLE_COLUMNS,rows:model.lifecycle},
      {name:"Entities",columns:ENTITY_COLUMNS,rows:model.entities},
      {name:"Sources",columns:SOURCE_COLUMNS,rows:model.sources},
      {name:"Rendered context",columns:CONTEXT_COLUMNS,rows:model.contexts},
    ];
  }
  function buildNoticeWorkbook(notice, trail, permalinkFor, context){
    return workbookBytes(enrichedSheets("Notice",[notice],{trail:trail||[],permalinkFor,context:context||{}}));
  }

  function buildEnrichedListWorkbook(sheetName, rows, options){
    return workbookBytes(enrichedSheets(sheetName,rows,options||{}));
  }

  function enrichedCsvColumns(options){
    options=options||{};
    const fields=[
      ["Plain-language summary","plain_language_summary"],["Lifecycle stage","lifecycle_stage"],
      ["Primary action URL","action_url"],["Boroughs","boroughs"],["Community districts","community_districts"],
      ["Council districts","council_districts"],["Neighborhoods","neighborhoods"],["Addresses","addresses"],
      ["Latitude","latitude"],["Longitude","longitude"],["BBLs","bbls"],["Project ID","project_id"],
      ["Project name","project_name"],["Vendor","vendor"],["Amount","amount"],
      ["Permalink","permalink"],["City Record URL","city_record_url"],
    ];
    return fields.map(([label,key])=>({
      label,
      value:row=>recordRow(row,{...options,context:typeof options.contextFor==="function"?options.contextFor(row):options.context})[key],
      type:["latitude","longitude","amount"].includes(key)?"number":"string",
      width:key.includes("url")||key==="plain_language_summary"?52:20,
    }));
  }

  function buildListWorkbook(sheetName, columns, rows){
    return workbookBytes([tabularSheet(sheetName,columns,rows)]);
  }

  return {
    EXPORT_CLASS_POLICY,excelSafeCsv,downloadFile,workbookBytes,recordRow,exportModel,
    enrichedCsvColumns,buildListWorkbook,buildEnrichedListWorkbook,buildNoticeWorkbook,
  };
});
