import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require=createRequire(import.meta.url);
const { workbookBytes, buildNoticeWorkbook }=require("../site/export_workflows.js");
const root=join(dirname(fileURLToPath(import.meta.url)),"..");
const out=join(root,"docs","evidence","export-refresh");
mkdirSync(out,{recursive:true});

const notice={
  request_id:"20260617050",
  type_of_notice_description:"Solicitation",
  section_name:"Procurement",
  category_description:"Construction/Construction Services",
  agency_name:"Housing Authority",
  short_title:"SMD_A&CM_RFQ #517992 - Elevator Rehabilitation and Maintenance and Service at Gun Hill Houses",
  start_date:"2026-06-30T00:00:00.000",
  due_date:"2026-08-05T11:00:00.000",
  pin:"517992",
  selection_method_description:"Competitive Sealed Bids",
  contact_name:"Procurement contact",
  address_to_request:"90 Church Street, New York, NY 10007",
};
const permalink=row=>`https://cityscroll.org/notices/${row.request_id}`;
const beforeColumns=[
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
const before=workbookBytes([{name:"Notice",columns:beforeColumns,rows:[{...notice,permalink:permalink(notice)}]}]);

const context={
  primary_action_url:"https://www.nyc.gov/site/nycha/business/isupplier-vendor-registration.page",
  actions:[
    {type:"official_handoff",label:"Open iSupplier",destination:"https://www.nyc.gov/site/nycha/business/isupplier-vendor-registration.page",delivery:"official_handoff",deadline:notice.due_date},
    {type:"calendar",label:"Add deadline to calendar",deadline:notice.due_date},
  ],
  lifecycle:{timeline:[
    {stage:"solicitation",status:"matched",date:"2026-06-30",detail:{title:notice.short_title,request_id:notice.request_id,due_date:notice.due_date},source_url:`https://a856-cityrecord.nyc.gov/RequestDetail/${notice.request_id}`},
    {stage:"selection",status:"unmatched",detail:{title:"Next expected stage"}},
  ]},
  entities:[{entity_type:"agency",name:"Housing Authority",relationship:"published by",url:"https://cityscroll.org/agencies/housing-authority/",evidence:"City Record agency field"}],
  sources:[{source_class:"action",label:"Housing Authority iSupplier registration guide",url:"https://www.nyc.gov/site/nycha/business/isupplier-vendor-registration.page"}],
  rendered_context:[
    {data_class:"actions",text:"Open iSupplier. Search ID 517992, confirm the procurement name, and upload the complete bid before the deadline.",links:["https://www.nyc.gov/site/nycha/business/isupplier-vendor-registration.page"]},
    {data_class:"procurement_lifecycle",text:"Solicitation is current. Selection is the next expected stage.",links:[`https://a856-cityrecord.nyc.gov/RequestDetail/${notice.request_id}`]},
  ],
};
const after=buildNoticeWorkbook(notice,[],permalink,context);

writeFileSync(join(out,"single-notice-before.xlsx"),before);
writeFileSync(join(out,"single-notice-after.xlsx"),after);
