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
    const day=text.match(/^\d{4}-\d{2}-\d{2}/);
    const date=new Date(day ? day[0]+"T00:00:00Z" : text);
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
    if(type==="date"){
      const serial=excelDate(value);
      return serial==null ? inlineCell(ref,"") : `<c r="${ref}" s="1"><v>${serial}</v></c>`;
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
  <sheetViews><sheetView workbookViewId="0"/></sheetViews>
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
  <numFmts count="0"/>
  <fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="3">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"><alignment wrapText="1"/></xf>
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

  function buildNoticeWorkbook(notice, trail, permalinkFor){
    const linkFor=typeof permalinkFor==="function" ? permalinkFor : row=>row.permalink||"";
    const noticeColumns=[
      {label:"Request ID",key:"request_id",type:"string",width:18},
      {label:"Type",key:"type_of_notice_description",type:"string",width:22},
      {label:"Agency",key:"agency_name",type:"string",width:32},
      {label:"Title",key:"short_title",type:"string",width:48},
      {label:"Posted",key:"start_date",type:"date",width:13},
      {label:"Due / event",key:"due_date",type:"date",width:13},
      {label:"Amount",key:"contract_amount",type:"number",width:16},
      {label:"PIN",key:"pin",type:"string",width:20},
      {label:"Vendor",key:"vendor_name",type:"string",width:32},
      {label:"Permalink",key:"permalink",type:"string",width:52},
    ];
    const trailColumns=[
      {label:"Request ID",key:"request_id",type:"string",width:18},
      {label:"Stage",key:"type_of_notice_description",type:"string",width:22},
      {label:"Posted",key:"start_date",type:"date",width:13},
      {label:"Amount",key:"contract_amount",type:"number",width:16},
      {label:"Vendor",key:"vendor_name",type:"string",width:32},
      {label:"PIN",key:"pin",type:"string",width:20},
      {label:"Permalink",key:"permalink",type:"string",width:52},
    ];
    const main={...notice,due_date:notice.due_date||notice.event_date||"",permalink:linkFor(notice)};
    const trailRows=(trail||[]).map(row=>({...row,permalink:linkFor(row)}));
    return workbookBytes([
      {name:"Notice",columns:noticeColumns,rows:[main]},
      {name:"Contract trail",columns:trailColumns,rows:trailRows},
    ]);
  }

  function buildListWorkbook(sheetName, columns, rows){
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
    return workbookBytes([{name:sheetName,columns:workbookColumns,rows:workbookRows}]);
  }

  return {excelSafeCsv,downloadFile,workbookBytes,buildListWorkbook,buildNoticeWorkbook};
});
