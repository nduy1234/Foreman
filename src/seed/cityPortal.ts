/**
 * Mock "City of Riverside permit portal" export (CSV), standing in for a real jurisdiction
 * portal API. Records are permit plan-check events and inspection results. Dates are day
 * offsets from today so the demo stays current. `jira` is the Foreman demo seed id the record
 * relates to (resolved to an issue key at ingest time); blank = another project (history).
 */
export const CITY_PORTAL_CSV = `recordId,type,permitNo,project,jira,status,dayOffset,official,officialEmail,title,detail
CR-24019,plan_check,MEP-2026-0977,Riverside Commons,P3,Comments issued,-9,M. Chen,mchen@riverside-demo.example,MEP plan check: comments issued,"Provide stamped load calculations for panels L2A/L2B and revise riser diagram; resubmittal required before approval."
CR-24020,plan_check,MEP-2026-0977,Riverside Commons,P3,Awaiting resubmittal,-2,M. Chen,mchen@riverside-demo.example,MEP plan check: awaiting applicant resubmittal,"No resubmittal received from applicant. Review clock paused."
CR-23811,permit,BLD-2026-0412-F,Riverside Commons,P1,Expiration notice,-1,J. Ortiz,jortiz@riverside-demo.example,Foundation permit expiration notice,"Permit expires in 15 days without a passed inspection or approved extension request."
CR-23544,inspection,BLD-2026-0412-F,Riverside Commons,I2,Approved with note,-35,J. Ortiz,jortiz@riverside-demo.example,Foundation reinforcement inspection result,"Approved to pour. Note: verify bottom mat spacing against S-101 at grid B-C before next pour."
CR-23490,inspection,BLD-2026-0412-F,Riverside Commons,I1,Approved,-40,J. Ortiz,jortiz@riverside-demo.example,Footing inspection result,"Footings approved."
CR-23901,inspection,BLD-2026-0413,Riverside Commons,I3,Approved,-20,J. Ortiz,jortiz@riverside-demo.example,Underground plumbing inspection result,"DWV test witnessed, approved."
CR-24055,inspection_request,BLD-2026-0413,Riverside Commons,I5,Requested,-1,J. Ortiz,jortiz@riverside-demo.example,Framing inspection request received,"Requested by Keystone Framing. City note: slab inspection must pass first."
CR-19877,inspection,BLD-2025-1180,Sunset Lofts,,Correction notice,-210,J. Ortiz,jortiz@riverside-demo.example,Sunset Lofts framing inspection: correction notice,"Hold-downs missing at shear wall grid C; re-inspection passed 6 days later after RFI response."
CR-20112,plan_check,MEP-2025-0533,Sunset Lofts,,Approved after resubmittal,-180,M. Chen,mchen@riverside-demo.example,Sunset Lofts MEP plan check approved after resubmittal,"Approved 16 days after first comments once load calculations were resubmitted."`;

export interface PortalRecord {
  recordId: string;
  type: 'plan_check' | 'permit' | 'inspection' | 'inspection_request';
  permitNo: string;
  project: string;
  jira: string | null;
  status: string;
  dayOffset: number;
  official: string;
  officialEmail: string;
  title: string;
  detail: string;
}

/** Minimal RFC 4180 CSV parser (quoted fields, embedded commas). Exported for tests. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => x.trim()));
}

export function portalRecords(csv = CITY_PORTAL_CSV): PortalRecord[] {
  const [header, ...rows] = parseCsv(csv);
  return rows.map((r) => {
    const o = Object.fromEntries(header.map((h, i) => [h, r[i] ?? '']));
    return {
      recordId: o.recordId,
      type: o.type as PortalRecord['type'],
      permitNo: o.permitNo,
      project: o.project,
      jira: o.jira || null,
      status: o.status,
      dayOffset: Number(o.dayOffset),
      official: o.official,
      officialEmail: o.officialEmail,
      title: o.title,
      detail: o.detail,
    };
  });
}
