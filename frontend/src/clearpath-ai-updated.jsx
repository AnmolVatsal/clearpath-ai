import { useState, useRef, useEffect } from "react";

// ═══════════════════════════════════════════════════════
// DETERMINISTIC AI ENGINE
// ═══════════════════════════════════════════════════════
function runPriorAuth(patient) {
  const p = patient;
  const highRisk = p.riskScore > 65;
  const requiresAuth = p.requestedProcedure.requiresAuth;
  const severe = p.diagnosisSeverity === "Severe";
  const comorbCount = p.disease.comorbidities.filter(c => c !== "None").length;
  let decision, confidence, appeal_pathway;
  if (!requiresAuth) {
    decision = "APPROVED"; confidence = 97;
    appeal_pathway = "N/A — No prior auth required for this CPT.";
  } else if (severe && comorbCount >= 2) {
    decision = "APPROVED"; confidence = 88;
    appeal_pathway = "N/A";
  } else if (highRisk && p.deductibleMet < p.deductible * 0.3) {
    decision = "NEEDS_REVIEW"; confidence = 62;
    appeal_pathway = "Submit detailed clinical notes + attending physician letter.";
  } else if (!severe && !highRisk && p.insurer === "Cigna") {
    decision = "DENIED"; confidence = 74;
    appeal_pathway = "File Level 1 appeal with supporting ICD documentation within 30 days.";
  } else {
    decision = "APPROVED"; confidence = 82 + (comorbCount * 3);
    appeal_pathway = "N/A";
  }
  const reasoning = `1. Medical Necessity: Patient presents with ${p.primaryDiagnosis.name} (${p.primaryDiagnosis.icd10}), severity ${p.diagnosisSeverity}. ${severe ? "Severity level warrants immediate intervention." : "Condition is manageable but warrants monitoring."}\n\n2. CPT-ICD Alignment: Procedure ${p.requestedProcedure.code} (${p.requestedProcedure.name}) is ${requiresAuth ? "clinically indicated" : "directly appropriate"} for diagnosis ${p.primaryDiagnosis.icd10}. Standard of care guidelines support this pairing.\n\n3. Payer Policy (${p.insurer}): Patient's plan covers this procedure category. Deductible met: $${p.deductibleMet} of $${p.deductible}. Comorbidities noted: ${p.disease.comorbidities.join(", ")}.\n\n4. Regulatory Basis: Aligns with CMS LCD L${30000 + p.riskScore} — ${p.primaryDiagnosis.category} procedures. NCCI bundling rules checked — no conflicts detected.\n\n5. Edge Cases: Risk score ${p.riskScore}/100. ${highRisk ? "Elevated risk — recommend concurrent case management." : "Risk within acceptable range."} Allergies on file: ${p.allergies.join(", ")}.`;
  const regulatory_basis = `CMS LCD L${30000 + p.riskScore} — ${p.primaryDiagnosis.category} · ${p.insurer} Policy Section 4.${p.disease.comorbidities.length}.${p.copay}`;
  return { decision, confidence: Math.min(confidence, 98), reasoning, regulatory_basis, appeal_pathway };
}

function runClaims(patient) {
  const p = patient;
  const billed = p.billedAmount;
  const highFraud = p.flagged || p.riskScore > 72;
  const bundling = p.requestedProcedure.code === "27447" || p.requestedProcedure.code === "93306";
  let decision, allowed_amount, ncci_check, fraud_score, denial_reason = "", notes;
  fraud_score = highFraud ? 42 + (p.riskScore % 30) : 8 + (p.riskScore % 18);
  ncci_check = bundling ? "FLAG" : "PASS";
  if (fraud_score > 60) {
    decision = "NEEDS_REVIEW"; allowed_amount = Math.round(billed * 0.6);
    denial_reason = "Elevated fraud indicators — manual review required.";
  } else if (ncci_check === "FLAG") {
    decision = "PARTIAL"; allowed_amount = Math.round(billed * 0.78);
    notes = "NCCI bundling flag applied — partial reimbursement per CMS fee schedule.";
  } else if (p.deductibleMet < p.deductible) {
    const gap = p.deductible - p.deductibleMet;
    decision = "APPROVED"; allowed_amount = Math.max(0, Math.round(billed * 0.85) - gap);
    notes = `Deductible gap of $${gap} applied. Remaining covered at 85% contracted rate.`;
  } else {
    decision = "APPROVED"; allowed_amount = Math.round(billed * 0.85);
    notes = `Claim adjudicated at 85% contracted rate for ${p.insurer}. CPT ${p.requestedProcedure.code} validated against ICD-10 ${p.primaryDiagnosis.icd10}. No NCCI conflicts. Payment scheduled.`;
  }
  return { decision, allowed_amount, ncci_check, fraud_score, denial_reason, notes: notes || denial_reason };
}

function runPolicySim(scenario, patient) {
  const sims = {
    1: { approval_rate_delta: "-18%", affected_cpt_codes: ["70553","70551","70552"], financial_impact: "$42,000 per 1,000 claims", workflow_changes: "CRAs must collect 6-week PT notes before submission. New checklist required.", risk_level: "HIGH", recommendation: "Update submission templates immediately. Notify referring physicians of new documentation requirements." },
    2: { approval_rate_delta: "+12%", affected_cpt_codes: ["99213","99214","99215"], financial_impact: "-$8,400 per 1,000 claims (cost reduction)", workflow_changes: "Telehealth flag must be added to all 99213 claims. EHR update required.", risk_level: "LOW", recommendation: "Implement telehealth modifier across billing system. Opportunity to reduce prior auth backlog." },
    3: { approval_rate_delta: "-24%", affected_cpt_codes: ["27447","27445","27446"], financial_impact: "$96,000 per 1,000 claims", workflow_changes: "3-month PT documentation workflow needed. Step therapy tracker must be added to EHR.", risk_level: "HIGH", recommendation: "Audit all pending 27447 submissions. Build PT documentation checklist into pre-auth workflow immediately." },
  };
  const base = sims[scenario.id] || sims[1];
  if (patient) {
    const relevant = base.affected_cpt_codes.includes(patient.requestedProcedure.code);
    return { ...base, recommendation: relevant ? `⚠ ${patient.name} (${patient.requestedProcedure.code}) is directly affected. ${base.recommendation}` : `${patient.name}'s CPT ${patient.requestedProcedure.code} is not in scope. ${base.recommendation}` };
  }
  return base;
}

// ═══════════════════════════════════════════════════════
// AUTO-ADJUDICATION ENGINE  — criteria-driven, instant decision
// ═══════════════════════════════════════════════════════

// CPT ↔ ICD-10 compatibility matrix (procedure must be clinically
// appropriate for the patient's primary diagnosis category)
const CPT_ICD_MATRIX = {
  "99213": ["Endocrine","Cardiovascular","Musculoskeletal","Respiratory","Mental Health","Nephrology","Gastroenterology"], // office visit covers everything
  "27447": ["Musculoskeletal"],
  "70553": ["Cardiovascular","Musculoskeletal","Nephrology","Mental Health"],
  "93306": ["Cardiovascular","Nephrology"],
  "45378": ["Gastroenterology","Nephrology"],
  "71046": ["Respiratory","Cardiovascular","Endocrine"],
  "83036": ["Endocrine","Cardiovascular","Nephrology"],
  "90837": ["Mental Health","Endocrine"],
};

// Hard denial codes — these insurers require extra docs for specific CPTs
const STRICT_AUTH_INSURERS = {
  "Cigna":        ["27447","70553","90837"],
  "Humana":       ["27447","93306"],
  "UnitedHealth": ["70553","45378"],
};

function runAutoAdjudication(submission, patient) {
  const cpt       = CPT_LIST.find(c => c.code === submission.cptCode) || patient.requestedProcedure;
  const billed    = Number(submission.billedAmount) || patient.billedAmount;
  const isNew     = submission.claimType === "NEW";
  const isAppeal  = submission.claimType === "APPEAL";
  const isResend  = submission.claimType === "RESEND";

  // ── Derived flags ──────────────────────────────────────────────────────
  const fraudScore      = patient.flagged ? 55 + (patient.riskScore % 30) : 8 + (patient.riskScore % 20);
  const ncciFlag        = ["27447","93306"].includes(cpt.code);
  const maxReasonable   = cpt.avgCost * 2.5;
  const deductibleGap   = Math.max(0, patient.deductible - patient.deductibleMet);
  const descLen         = (submission.issueDescription || "").trim().length;
  const docsLen         = (submission.additionalNotes  || "").trim().length;
  const strictInsurer   = (STRICT_AUTH_INSURERS[patient.insurer] || []).includes(cpt.code);
  const icdCompatible   = (CPT_ICD_MATRIX[cpt.code] || []).includes(patient.primaryDiagnosis.category);
  const authOk          = !cpt.requiresAuth || patient.authStatus === "APPROVED" || patient.authStatus === "NEEDS_REVIEW";
  const alreadyPaid     = patient.claimHistory.some(c => c.cpt === cpt.code && (c.status === "PAID" || c.status === "APPROVED"));
  const severeEnough    = patient.diagnosisSeverity === "Severe" || patient.diagnosisSeverity === "Moderate";
  const hasGoodDocs     = docsLen > 50;
  const hasDescription  = descLen > 25;
  const billedReasonable = billed <= maxReasonable && billed > 0;

  // ── Criteria table ─────────────────────────────────────────────────────
  // Each criterion: { id, label, passed, critical, detail, weight }
  // critical=true → a FAIL here auto-denies regardless of other scores
  const criteria = [
    {
      id: "icd_cpt_match",
      label: "CPT–ICD-10 Alignment",
      passed: icdCompatible,
      critical: true,
      detail: icdCompatible
        ? `CPT ${cpt.code} (${cpt.name}) is clinically appropriate for ${patient.primaryDiagnosis.name} [${patient.primaryDiagnosis.icd10}].`
        : `CPT ${cpt.code} (${cpt.name}) is NOT indicated for ${patient.primaryDiagnosis.category} diagnoses per CMS LCD guidelines.`,
      weight: 25,
    },
    {
      id: "fraud_check",
      label: "Fraud & Risk Score",
      passed: fraudScore < 55,
      critical: fraudScore > 75,
      detail: fraudScore < 55
        ? `Fraud score ${fraudScore}/100 — within acceptable threshold. No anomalies detected.`
        : fraudScore <= 75
          ? `Fraud score ${fraudScore}/100 — elevated. Patient record flagged: ${patient.flagged}. Manual review recommended.`
          : `Fraud score ${fraudScore}/100 — HIGH. Claim suspended pending investigation per ${patient.insurer} anti-fraud policy.`,
      weight: 20,
    },
    {
      id: "auth_status",
      label: "Prior Authorization",
      passed: authOk,
      critical: cpt.requiresAuth && patient.authStatus === "DENIED",
      detail: !cpt.requiresAuth
        ? `CPT ${cpt.code} does not require prior authorization — direct access permitted.`
        : authOk
          ? `Prior authorization on file — status: ${patient.authStatus}.`
          : `CPT ${cpt.code} requires prior authorization. Current auth status: ${patient.authStatus}. Claim cannot proceed without valid authorization.`,
      weight: 20,
    },
    {
      id: "billed_amount",
      label: "Billed Amount Reasonableness",
      passed: billedReasonable,
      critical: billed > cpt.avgCost * 4,
      detail: billedReasonable
        ? `$${billed.toLocaleString()} billed vs. $${cpt.avgCost.toLocaleString()} avg for CPT ${cpt.code} — within 2.5× ceiling.`
        : billed > cpt.avgCost * 4
          ? `$${billed.toLocaleString()} billed is ${(billed / cpt.avgCost).toFixed(1)}× the average. Exceeds overbilling threshold — claim flagged.`
          : `$${billed.toLocaleString()} billed is ${(billed / cpt.avgCost).toFixed(1)}× the average — slightly above threshold.`,
      weight: 15,
    },
    {
      id: "duplicate_check",
      label: "Duplicate Claim Check",
      passed: !alreadyPaid || isAppeal || isResend,
      critical: alreadyPaid && isNew,
      detail: alreadyPaid && isNew
        ? `A claim for CPT ${cpt.code} was already APPROVED/PAID. New claims for the same procedure within the same period are not permitted.`
        : `No duplicate paid claim found for CPT ${cpt.code}. Claim is eligible for adjudication.`,
      weight: 10,
    },
    {
      id: "ncci_bundling",
      label: "NCCI Bundling Check",
      passed: !ncciFlag,
      critical: false,
      detail: ncciFlag
        ? `CPT ${cpt.code} is subject to NCCI bundling rules. Partial reimbursement (78%) applies per CMS fee schedule edit.`
        : `No NCCI bundling conflicts for CPT ${cpt.code}.`,
      weight: 5,
    },
    {
      id: "insurer_policy",
      label: `${patient.insurer} Policy Compliance`,
      passed: !strictInsurer || hasGoodDocs,
      critical: strictInsurer && isNew && !hasGoodDocs,
      detail: !strictInsurer
        ? `CPT ${cpt.code} has no special restrictions under ${patient.insurer} policy.`
        : hasGoodDocs
          ? `${patient.insurer} requires detailed documentation for CPT ${cpt.code} — provided (${docsLen} chars).`
          : `${patient.insurer} requires clinical documentation for CPT ${cpt.code}. Insufficient documentation submitted (${docsLen} chars, minimum 50 required).`,
      weight: 10,
    },
    {
      id: "documentation",
      label: "Claim Description Quality",
      passed: hasDescription,
      critical: !hasDescription,
      detail: hasDescription
        ? `Claim description provided (${descLen} chars). Sufficient clinical context for adjudication.`
        : `No claim description provided. All submissions require a minimum description of the clinical issue.`,
      weight: 10,
    },
    {
      id: "medical_necessity",
      label: "Medical Necessity",
      passed: severeEnough || !cpt.requiresAuth,
      critical: false,
      detail: !cpt.requiresAuth
        ? `Procedure does not require necessity justification — non-auth CPT.`
        : severeEnough
          ? `Diagnosis severity "${patient.diagnosisSeverity}" supports necessity for ${cpt.name}.`
          : `Diagnosis severity "${patient.diagnosisSeverity}" may not meet medical necessity threshold for ${cpt.name}. Additional clinical justification recommended.`,
      weight: 10,
    },
    {
      id: "appeal_docs",
      label: isAppeal ? "Appeal Documentation" : isResend ? "Correction Documentation" : "Supporting Documentation",
      passed: isNew ? true : hasGoodDocs,
      critical: isAppeal && !hasDescription,
      detail: isNew
        ? "New claim — supporting documentation is optional but recommended."
        : hasGoodDocs
          ? `Adequate supporting documentation submitted (${docsLen} chars). Strengthens the ${isAppeal ? "appeal" : "re-submission"}.`
          : `Minimal supporting documentation (${docsLen} chars). ${isAppeal ? "Appeals" : "Re-submissions"} with detailed notes have significantly higher approval rates.`,
      weight: isNew ? 0 : 15,
    },
  ];

  // ── Score & decide ─────────────────────────────────────────────────────
  const criticalFail = criteria.find(c => c.critical && !c.passed);
  const totalWeight  = criteria.reduce((s,c) => s + c.weight, 0);
  const passedWeight = criteria.filter(c => c.passed).reduce((s,c) => s + c.weight, 0);
  const score        = Math.round((passedWeight / totalWeight) * 100);

  let finalStatus, confidence, autoNote, regulatory_basis;

  if (criticalFail) {
    finalStatus = "DENIED";
    confidence  = 92;
    autoNote    = `Auto-denied: Critical criterion failed — "${criticalFail.label}". ${criticalFail.detail}`;
    regulatory_basis = `CMS Claims Adjudication Policy · ${patient.insurer} Coverage Rules · NCCI Edit Check`;
  } else if (score >= 75) {
    finalStatus = "APPROVED";
    confidence  = score;
    autoNote    = `Auto-approved: ${criteria.filter(c=>c.passed).length}/${criteria.length} criteria passed (score ${score}/100). ${ncciFlag ? "NCCI partial reimbursement applies." : "Full reimbursement eligible at contracted rate."}`;
    regulatory_basis = `CMS LCD L${30000 + patient.riskScore} · ${patient.insurer} Policy · ACA §1557`;
  } else if (score >= 50) {
    finalStatus = "NEEDS_REVIEW";
    confidence  = score;
    autoNote    = `Borderline score ${score}/100 — ${criteria.filter(c=>!c.passed).length} criteria failed. Routed for manual review. Failed: ${criteria.filter(c=>!c.passed).map(c=>c.label).join(", ")}.`;
    regulatory_basis = `${patient.insurer} Manual Review Policy · CMS PA Final Rule (2026)`;
  } else {
    finalStatus = "DENIED";
    confidence  = 100 - score;
    autoNote    = `Auto-denied: Score ${score}/100 — insufficient criteria met. Failed checks: ${criteria.filter(c=>!c.passed).map(c=>c.label).join("; ")}.`;
    regulatory_basis = `CMS Claims Adjudication Policy · ${patient.insurer} Coverage Rules`;
  }

  // Appeal-specific override: even borderline appeals get accepted if docs are good
  if (isAppeal && hasGoodDocs && !criticalFail && score >= 45) {
    finalStatus = "APPROVED";
    confidence  = Math.max(score, 68);
    autoNote    = `Appeal auto-approved: Sufficient supporting documentation provided with no critical violations. ${patient.insurer} Level 1 appeal rights exercised per ACA §1557. ${autoNote}`;
  }

  const allowed_amount = finalStatus === "APPROVED"
    ? ncciFlag
      ? Math.round(billed * 0.78)
      : deductibleGap > 0
        ? Math.max(0, Math.round(billed * 0.85) - deductibleGap)
        : Math.round(billed * 0.85)
    : finalStatus === "NEEDS_REVIEW"
      ? Math.round(billed * 0.60)
      : 0;

  return {
    finalStatus,
    confidence,
    score,
    criteria,
    criticalFail: criticalFail || null,
    autoNote,
    regulatory_basis,
    allowed_amount,
    ncciFlag,
    fraudScore,
    deductibleGap,
    passedCount:  criteria.filter(c => c.passed).length,
    totalCount:   criteria.length,
  };
}

// ═══════════════════════════════════════════════════════
// SYNTHETIC DATABASE
// ═══════════════════════════════════════════════════════
const DISEASES = [
  { icd10:"E11.9", name:"Type 2 Diabetes", category:"Endocrine", severity:"Chronic", treatments:["Metformin","Insulin Therapy"], comorbidities:["Hypertension","Obesity"] },
  { icd10:"I10",   name:"Essential Hypertension", category:"Cardiovascular", severity:"Chronic", treatments:["Amlodipine","Losartan"], comorbidities:["Diabetes","CKD"] },
  { icd10:"M54.5", name:"Low Back Pain", category:"Musculoskeletal", severity:"Acute", treatments:["Physiotherapy","NSAIDs"], comorbidities:["Obesity","Spondylosis"] },
  { icd10:"J18.9", name:"Pneumonia", category:"Respiratory", severity:"Acute", treatments:["Antibiotics","Oxygen Therapy"], comorbidities:["COPD","Immunodeficiency"] },
  { icd10:"F32.1", name:"Major Depression", category:"Mental Health", severity:"Chronic", treatments:["SSRIs","CBT"], comorbidities:["Anxiety","Insomnia"] },
  { icd10:"N18.3", name:"Chronic Kidney Disease", category:"Nephrology", severity:"Chronic", treatments:["ACE Inhibitors","Diet Restriction"], comorbidities:["Hypertension","Diabetes"] },
  { icd10:"K21.0", name:"GERD", category:"Gastroenterology", severity:"Chronic", treatments:["PPIs","H2 Blockers"], comorbidities:["Obesity","Hiatal Hernia"] },
  { icd10:"J45.9", name:"Asthma", category:"Respiratory", severity:"Chronic", treatments:["Salbutamol","Corticosteroids"], comorbidities:["Allergic Rhinitis","GERD"] },
];
const CPT_LIST = [
  { code:"99213", name:"Office Visit", category:"E&M", avgCost:150, requiresAuth:false },
  { code:"27447", name:"Total Knee Arthroplasty", category:"Orthopedic", avgCost:18000, requiresAuth:true },
  { code:"70553", name:"MRI Brain w/ Contrast", category:"Radiology", avgCost:2800, requiresAuth:true },
  { code:"93306", name:"Echocardiogram", category:"Cardiology", avgCost:1200, requiresAuth:true },
  { code:"45378", name:"Colonoscopy", category:"Gastroenterology", avgCost:2100, requiresAuth:true },
  { code:"71046", name:"Chest X-Ray", category:"Radiology", avgCost:280, requiresAuth:false },
  { code:"83036", name:"HbA1c Test", category:"Lab", avgCost:45, requiresAuth:false },
  { code:"90837", name:"Psychotherapy 60 min", category:"Mental Health", avgCost:180, requiresAuth:true },
];
const INSURERS = ["UnitedHealth","Anthem BCBS","Aetna","Cigna","Humana","Star Health"];
const STATES   = ["Maharashtra","Karnataka","Tamil Nadu","Delhi","West Bengal","Gujarat"];
const NAMES = [
  ["Priya","Sharma"],["Arjun","Patel"],["Meera","Iyer"],["Rohan","Reddy"],["Ananya","Singh"],
  ["Vikram","Kumar"],["Sana","Nair"],["Kartik","Mehta"],["Divya","Joshi"],["Rahul","Gupta"],
  ["Aisha","Bose"],["Suresh","Pillai"],["Kavya","Verma"],["Amit","Shah"],["Pooja","Rao"],
];
const BLOOD = ["A+","B+","O+","AB+","A-","B-","O-","AB-"];
const ALLERGY_LIST = [["Penicillin"],["None"],["None"],["Sulfa","Aspirin"],["None"]];

const DB_PATIENTS = NAMES.map(([fn,ln], i) => {
  const disease = DISEASES[i % DISEASES.length];
  const proc    = CPT_LIST[i % CPT_LIST.length];
  const age     = 25 + (i * 13) % 55;
  return {
    id: `PT-${String(10001+i).padStart(5,"0")}`,
    username: `${fn.toLowerCase()}${i+1}`,
    password: `pass${i+1}`,
    name: `${fn} ${ln}`, age,
    gender: ["Male","Female","Other"][i%3],
    dob: `${1999-age}-${String((i%12)+1).padStart(2,"0")}-${String((i*3+1)%28+1).padStart(2,"0")}`,
    bloodGroup: BLOOD[i%8],
    phone: `+91 ${7000000000 + i*111111111}`,
    email: `${fn.toLowerCase()}.${ln.toLowerCase()}@email.com`,
    address: `${(i+1)*12} Main St, ${STATES[i%6]}`,
    occupation: ["Engineer","Teacher","Doctor","Lawyer","Farmer","Student","Nurse"][i%7],
    insurer: INSURERS[i%6],
    policyNo: `POL-${100000+i*1337}`,
    memberId: `MEM-${10000+i*337}`,
    groupId: `GRP-${1000+i*37}`,
    deductible: [500,1000,1500,2000,2500][i%5],
    deductibleMet: (i*150)%2000,
    copay: [20,30,40,50][i%4],
    primaryDiagnosis: disease,
    diagnosisDate: `2024-${String((i%12)+1).padStart(2,"0")}-15`,
    diagnosisSeverity: ["Mild","Moderate","Severe"][i%3],
    disease,
    medications: disease.treatments.slice(0,2),
    allergies: ALLERGY_LIST[i%5],
    vitals: {
      bp: `${110+(i*3)%40}/${70+(i*2)%20} mmHg`,
      pulse: `${60+(i*7)%40} bpm`,
      temp: `${(36.0+(i*0.15)%2.0).toFixed(1)}°C`,
      bmi: (18+(i*1.1)%20).toFixed(1),
      spo2: `${94+i%6}%`,
    },
    requestedProcedure: proc,
    billedAmount: proc.avgCost * (0.85+(i%3)*0.1),
    claimHistory: Array.from({length:(i%3)+1},(_,j)=>({
      claimId:`CLM-${100000+i*100+j}`,
      date:`2024-${String((j*3+1)%12+1).padStart(2,"0")}-15`,
      amount:500+(i*j*200)%4500,
      status:["APPROVED","DENIED","PAID","PENDING"][j%4],
      cpt:CPT_LIST[j%8].code,
      denialReason: ["DENIED"].includes(["APPROVED","DENIED","PAID","PENDING"][j%4]) ? ["Medical necessity not established","CPT-ICD mismatch","Missing documentation","Deductible not met","Non-covered service"][i%5] : null,
    })),
    riskScore: 20+(i*13+7)%80,
    flagged: i%7===0,
    lastVisit: `2025-${String((i%3)+1).padStart(2,"0")}-${String((i*4+1)%28+1).padStart(2,"0")}`,
    authStatus: ["APPROVED","PENDING","DENIED","APPROVED","NEEDS_REVIEW"][i%5],
    claimStatus: ["PAID","PENDING","APPROVED","DENIED","PROCESSING"][i%5],
  };
});

// ═══════════════════════════════════════════════════════
// BLOCKCHAIN
// ═══════════════════════════════════════════════════════
let _chain = [];
function hashStr(s) { let h=0; for(const c of s) h=((h<<5)-h+c.charCodeAt(0))|0; return "0x"+Math.abs(h).toString(16).padStart(8,"0").toUpperCase(); }
function sealToChain(entry) {
  const prev = _chain.length ? _chain[_chain.length-1].hash : "0x00000000";
  const hash = hashStr(JSON.stringify(entry)+prev);
  const block = {...entry, hash, prevHash:prev, timestamp:new Date().toISOString(), blockIndex:_chain.length};
  _chain=[..._chain,block]; return block;
}

// ═══════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════
const ADMIN_USER = { username:"admin", password:"admin123", role:"admin" };
const ALL_USERS  = [ADMIN_USER, ...DB_PATIENTS.map(p=>({ username:p.username, password:p.password, role:"patient", patientId:p.id }))];

// ═══════════════════════════════════════════════════════
// CSS
// ═══════════════════════════════════════════════════════
const css = `
@import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Syne:wght@700;800&family=DM+Sans:wght@400;500;600&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
:root{
  --bg:#06090f;--sf:#0b1420;--s2:#101d2f;--s3:#152336;
  --bd:#1b2e44;--b2:#243d58;
  --ac:#00ccff;--a2:#8b5cf6;
  --gr:#10b981;--re:#ef4444;--am:#f59e0b;
  --or:#f97316;
  --tx:#d8e8f4;--mu:#4a6d8c;--di:#263d52;
  --fh:'Syne',sans-serif;--fb:'DM Sans',sans-serif;--fm:'DM Mono',monospace;
}
body{background:var(--bg);color:var(--tx);font-family:var(--fb);min-height:100vh;}
.login-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;}
.login-box{width:360px;background:var(--sf);border:1px solid var(--bd);border-radius:14px;padding:32px;}
.login-logo{font-family:var(--fh);font-size:1.4rem;color:var(--ac);margin-bottom:4px;}
.login-sub{font-size:0.7rem;color:var(--mu);text-transform:uppercase;letter-spacing:1px;margin-bottom:26px;}
.login-tabs{display:flex;background:var(--bg);border-radius:8px;padding:3px;gap:3px;margin-bottom:20px;}
.ltab{flex:1;text-align:center;padding:7px;border-radius:6px;font-size:0.8rem;font-weight:600;cursor:pointer;color:var(--mu);transition:all 0.12s;}
.ltab.active{background:var(--s3);color:var(--ac);}
.hint{background:var(--s2);border:1px solid var(--bd);border-radius:8px;padding:10px 12px;margin-bottom:14px;font-size:0.71rem;color:var(--mu);line-height:1.7;}
.hint b{color:var(--ac);font-family:var(--fm);}
.lf{display:flex;flex-direction:column;gap:5px;margin-bottom:13px;}
.lf label{font-size:0.67rem;color:var(--mu);text-transform:uppercase;letter-spacing:0.8px;}
.lf input{background:var(--bg);border:1px solid var(--bd);border-radius:8px;padding:9px 12px;color:var(--tx);font-family:var(--fb);font-size:0.84rem;outline:none;transition:border-color 0.12s;}
.lf input:focus{border-color:var(--ac);}
.lerr{color:var(--re);font-size:0.74rem;margin-bottom:9px;text-align:center;}
.app{display:flex;min-height:100vh;}
.sidebar{width:218px;min-height:100vh;background:var(--sf);border-right:1px solid var(--bd);display:flex;flex-direction:column;position:fixed;top:0;left:0;z-index:200;}
.logo{padding:18px 15px 12px;border-bottom:1px solid var(--bd);}
.logo h1{font-family:var(--fh);font-size:1.05rem;color:var(--ac);}
.logo p{font-size:0.59rem;color:var(--mu);margin-top:2px;text-transform:uppercase;letter-spacing:1px;}
.nav{flex:1;padding:7px 6px;display:flex;flex-direction:column;gap:1px;}
.ns{font-size:0.57rem;color:var(--di);text-transform:uppercase;letter-spacing:1.5px;padding:9px 10px 3px;}
.ni{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:7px;cursor:pointer;font-size:0.77rem;font-weight:500;color:var(--mu);transition:all 0.1s;border:1px solid transparent;}
.ni:hover{background:var(--s2);color:var(--tx);}
.ni.active{background:rgba(0,204,255,0.07);color:var(--ac);border-color:rgba(0,204,255,0.18);}
.ni .ic{width:15px;text-align:center;font-size:0.82rem;}
.ni .bdg{margin-left:auto;font-size:0.57rem;background:rgba(0,204,255,0.12);color:var(--ac);padding:1px 6px;border-radius:9px;font-family:var(--fm);}
.ni .bdg-alert{margin-left:auto;font-size:0.57rem;background:rgba(249,115,22,0.18);color:var(--or);padding:1px 6px;border-radius:9px;font-family:var(--fm);animation:pulse 2s infinite;}
.sf2{padding:11px 13px;border-top:1px solid var(--bd);}
.uchip{display:flex;align-items:center;gap:8px;padding:7px 9px;background:var(--s2);border-radius:8px;margin-bottom:8px;}
.uav{width:27px;height:27px;border-radius:50%;background:linear-gradient(135deg,var(--a2),var(--ac));display:flex;align-items:center;justify-content:center;font-size:0.63rem;font-weight:700;color:#fff;flex-shrink:0;}
.uname{font-size:0.74rem;font-weight:600;color:var(--tx);}
.urole{font-size:0.59rem;color:var(--mu);}
.btnlo{width:100%;padding:6px;border-radius:7px;border:1px solid var(--bd);background:transparent;color:var(--mu);font-family:var(--fb);font-size:0.74rem;cursor:pointer;transition:all 0.1s;}
.btnlo:hover{border-color:var(--re);color:var(--re);}
.dl{width:6px;height:6px;border-radius:50%;background:var(--gr);box-shadow:0 0 6px var(--gr);animation:pulse 2s infinite;flex-shrink:0;}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
.main{margin-left:218px;flex:1;display:flex;flex-direction:column;}
.topbar{background:var(--sf);border-bottom:1px solid var(--bd);padding:10px 23px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100;}
.content{padding:20px 23px;flex:1;}
.card{background:var(--sf);border:1px solid var(--bd);border-radius:11px;padding:15px;margin-bottom:13px;}
.ct{font-family:var(--fh);font-size:0.67rem;color:var(--mu);text-transform:uppercase;letter-spacing:1.1px;margin-bottom:11px;display:flex;align-items:center;gap:7px;}
.ctb{font-size:0.57rem;padding:1px 7px;border-radius:9px;background:rgba(0,204,255,0.09);color:var(--ac);font-family:var(--fm);}
.ctba{font-size:0.57rem;padding:1px 7px;border-radius:9px;background:rgba(249,115,22,0.1);color:var(--or);font-family:var(--fm);}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:11px;}
.g3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:9px;}
.g4{display:grid;grid-template-columns:repeat(4,1fr);gap:9px;}
.sc{background:var(--sf);border:1px solid var(--bd);border-radius:10px;padding:13px;}
.sl{font-size:0.6rem;color:var(--mu);text-transform:uppercase;letter-spacing:0.8px;margin-bottom:4px;}
.sv{font-family:var(--fh);font-size:1.6rem;}
.ss{font-size:0.62rem;color:var(--mu);margin-top:1px;}
.green{color:var(--gr);}.red{color:var(--re);}.amber{color:var(--am);}.accent{color:var(--ac);}
.rt{display:inline-flex;align-items:center;gap:5px;font-size:0.63rem;color:var(--gr);background:rgba(16,185,129,0.07);padding:2px 8px;border-radius:9px;border:1px solid rgba(16,185,129,0.18);}
.ptselector{background:var(--sf);border:1px solid var(--bd);border-radius:11px;padding:13px;margin-bottom:13px;}
.pts-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:9px;}
.ptgrid{display:flex;flex-wrap:wrap;gap:5px;}
.ptchip{padding:4px 11px;border-radius:18px;border:1px solid var(--bd);background:var(--bg);font-size:0.7rem;cursor:pointer;transition:all 0.1s;color:var(--mu);}
.ptchip:hover{border-color:var(--ac);color:var(--tx);}
.ptchip.sel{background:rgba(0,204,255,0.08);border-color:var(--ac);color:var(--ac);}
.ptchip.flag{border-color:rgba(239,68,68,0.3);}
.ptcard{display:grid;grid-template-columns:auto 1fr;gap:12px;align-items:start;}
.ptav{width:44px;height:44px;border-radius:10px;background:linear-gradient(135deg,var(--a2),var(--ac));display:flex;align-items:center;justify-content:center;font-family:var(--fh);font-size:1.05rem;color:#fff;flex-shrink:0;}
.ptn{font-family:var(--fh);font-size:0.96rem;}
.ptid{font-family:var(--fm);font-size:0.62rem;color:var(--mu);margin-top:2px;}
.pttags{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;}
.tag{font-size:0.62rem;padding:2px 7px;border-radius:5px;font-family:var(--fm);}
.tb{background:rgba(0,204,255,0.08);color:var(--ac);border:1px solid rgba(0,204,255,0.18);}
.tp{background:rgba(139,92,246,0.08);color:#a78bfa;border:1px solid rgba(139,92,246,0.18);}
.tg{background:rgba(16,185,129,0.08);color:var(--gr);border:1px solid rgba(16,185,129,0.18);}
.tr{background:rgba(239,68,68,0.08);color:var(--re);border:1px solid rgba(239,68,68,0.18);}
.ta{background:rgba(245,158,11,0.08);color:var(--am);border:1px solid rgba(245,158,11,0.18);}
.tor{background:rgba(249,115,22,0.08);color:var(--or);border:1px solid rgba(249,115,22,0.18);}
.kv2{display:grid;grid-template-columns:1fr 1fr;gap:3px 12px;}
.kv{display:flex;flex-direction:column;gap:1px;padding:5px 0;border-bottom:1px solid var(--bd);}
.kvk{font-size:0.6rem;color:var(--mu);text-transform:uppercase;letter-spacing:0.7px;}
.kvv{font-size:0.75rem;color:var(--tx);font-weight:500;}
.vitrow{display:flex;gap:5px;flex-wrap:wrap;margin-top:3px;}
.vitpill{background:var(--bg);border:1px solid var(--bd);border-radius:7px;padding:5px 8px;text-align:center;flex:1;min-width:58px;}
.vitl{font-size:0.57rem;color:var(--mu);text-transform:uppercase;letter-spacing:0.4px;}
.vitv{font-size:0.75rem;font-weight:600;font-family:var(--fm);margin-top:1px;}
.rbar{height:5px;background:var(--bd);border-radius:3px;overflow:hidden;}
.rfill{height:100%;border-radius:3px;transition:width 0.5s ease;}
.btn{padding:8px 16px;border-radius:7px;border:none;cursor:pointer;font-family:var(--fb);font-size:0.79rem;font-weight:600;transition:all 0.1s;display:inline-flex;align-items:center;gap:6px;}
.btnp{background:var(--ac);color:#000;}
.btnp:hover{background:#22d9ff;transform:translateY(-1px);}
.btnp:disabled{opacity:0.4;cursor:not-allowed;transform:none;}
.btns{background:transparent;border:1px solid var(--bd);color:var(--tx);padding:5px 11px;border-radius:6px;font-size:0.73rem;font-weight:500;cursor:pointer;transition:all 0.1s;font-family:var(--fb);}
.btns:hover{border-color:var(--ac);color:var(--ac);}
.btnr{background:rgba(249,115,22,0.09);border:1px solid rgba(249,115,22,0.25);color:var(--or);padding:5px 11px;border-radius:6px;font-size:0.73rem;font-weight:600;cursor:pointer;transition:all 0.1s;font-family:var(--fb);}
.btnr:hover{background:rgba(249,115,22,0.16);}
.btnd{background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);color:var(--re);padding:4px 10px;border-radius:6px;font-size:0.71rem;font-weight:600;cursor:pointer;font-family:var(--fb);}
.btnd:hover{background:rgba(239,68,68,0.15);}
.btng{background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.2);color:var(--gr);padding:4px 10px;border-radius:6px;font-size:0.71rem;font-weight:600;cursor:pointer;font-family:var(--fb);}
.btng:hover{background:rgba(16,185,129,0.15);}
.dbsearch{background:var(--bg);border:1px solid var(--bd);border-radius:7px;padding:7px 10px;color:var(--tx);font-family:var(--fb);font-size:0.78rem;outline:none;width:100%;margin-bottom:10px;transition:border-color 0.1s;}
.dbsearch:focus{border-color:var(--ac);}
.rbox{background:var(--bg);border:1px solid var(--bd);border-radius:9px;padding:13px;margin-top:12px;animation:slideIn 0.25s ease;}
@keyframes slideIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.rh{display:flex;align-items:center;justify-content:space-between;margin-bottom:9px;flex-wrap:wrap;gap:7px;}
.rd{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:18px;font-size:0.72rem;font-weight:700;font-family:var(--fh);letter-spacing:0.5px;}
.approved{background:rgba(16,185,129,0.1);color:var(--gr);border:1px solid rgba(16,185,129,0.22);}
.denied{background:rgba(239,68,68,0.1);color:var(--re);border:1px solid rgba(239,68,68,0.22);}
.review{background:rgba(245,158,11,0.1);color:var(--am);border:1px solid rgba(245,158,11,0.22);}
.pending-r{background:rgba(249,115,22,0.1);color:var(--or);border:1px solid rgba(249,115,22,0.22);}
.cbar{height:4px;background:var(--bd);border-radius:3px;overflow:hidden;margin:7px 0;}
.cfill{height:100%;border-radius:3px;background:linear-gradient(90deg,var(--a2),var(--ac));animation:grow 0.6s ease;}
@keyframes grow{from{width:0%}to{}}
.reasoning{font-family:var(--fm);font-size:0.68rem;color:#6a9fbe;line-height:1.75;white-space:pre-wrap;max-height:200px;overflow-y:auto;}
.hb{font-family:var(--fm);font-size:0.6rem;color:var(--a2);background:rgba(139,92,246,0.07);padding:2px 7px;border-radius:4px;border:1px solid rgba(139,92,246,0.15);}
.steps-wrap{background:var(--bg);border:1px solid var(--bd);border-radius:9px;padding:9px;margin-bottom:11px;}
.step{display:flex;gap:7px;margin-bottom:4px;animation:slideIn 0.2s ease;}
.step:last-child{margin-bottom:0;}
.step-text{font-family:var(--fm);font-size:0.67rem;line-height:1.5;}
.step-done{color:var(--gr);}
.step-run{color:var(--ac);}
.dbtabs{display:flex;border-bottom:1px solid var(--bd);margin-bottom:11px;}
.dbt{padding:7px 13px;font-size:0.73rem;font-weight:500;cursor:pointer;color:var(--mu);border-bottom:2px solid transparent;margin-bottom:-1px;transition:all 0.1s;}
.dbt.active{color:var(--ac);border-bottom-color:var(--ac);}
.dbt:hover{color:var(--tx);}
.dbt2{width:100%;border-collapse:collapse;font-size:0.73rem;}
.dbt2 th{background:var(--s2);color:var(--mu);font-weight:600;text-align:left;padding:6px 10px;font-size:0.62rem;text-transform:uppercase;letter-spacing:0.7px;border-bottom:1px solid var(--bd);}
.dbt2 td{padding:6px 10px;border-bottom:1px solid var(--bd);color:var(--tx);vertical-align:middle;}
.dbt2 tr:last-child td{border-bottom:none;}
.dbt2 tr:hover td{background:var(--s2);}
.exprow td{padding:0;background:var(--bg)!important;}
.expinner{padding:11px 13px;border-top:1px solid var(--bd);}
.scroll{max-height:430px;overflow-y:auto;}
.scroll::-webkit-scrollbar{width:3px;}
.scroll::-webkit-scrollbar-thumb{background:var(--bd);border-radius:2px;}
.audit-item{border:1px solid var(--bd);border-radius:9px;padding:10px;margin-bottom:7px;background:var(--bg);}
.audit-item:hover{border-color:var(--a2);}
.barchart{display:flex;align-items:flex-end;gap:5px;height:70px;}
.bw{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;}
.bar{width:100%;border-radius:3px 3px 0 0;background:linear-gradient(180deg,var(--ac),var(--a2));opacity:0.7;}
.bl{font-size:0.57rem;color:var(--mu);}
.prow{display:flex;align-items:center;gap:9px;padding:5px 0;border-bottom:1px solid var(--bd);}
.prow:last-child{border-bottom:none;}
.pbar{flex:2;height:4px;background:var(--bd);border-radius:2px;overflow:hidden;}
.pf{height:100%;border-radius:2px;}
.feeditem{display:flex;align-items:flex-start;gap:8px;padding:6px 0;border-bottom:1px solid var(--bd);}
.feeditem:last-child{border-bottom:none;}
.fdot{width:6px;height:6px;border-radius:50%;margin-top:4px;flex-shrink:0;}
.sccard{border:1px solid var(--bd);border-radius:9px;padding:11px;cursor:pointer;transition:all 0.1s;background:var(--bg);}
.sccard:hover,.sccard.sel{border-color:var(--ac);background:rgba(0,204,255,0.03);}
.portal-hero{background:linear-gradient(135deg,rgba(0,204,255,0.06),rgba(139,92,246,0.06));border:1px solid var(--bd);border-radius:14px;padding:20px;margin-bottom:14px;}
/* ── APPEAL / CLAIM FORM ── */
.appeal-banner{background:linear-gradient(135deg,rgba(249,115,22,0.07),rgba(139,92,246,0.05));border:1px solid rgba(249,115,22,0.22);border-radius:11px;padding:14px;margin-bottom:13px;}
.appeal-form{background:var(--bg);border:1px solid var(--bd);border-radius:9px;padding:13px;margin-top:10px;animation:slideIn 0.2s ease;}
.aff{display:flex;flex-direction:column;gap:4px;margin-bottom:10px;}
.aff label{font-size:0.63rem;color:var(--mu);text-transform:uppercase;letter-spacing:0.7px;}
.aff input,.aff select,.aff textarea{background:var(--s2);border:1px solid var(--bd);border-radius:7px;padding:7px 10px;color:var(--tx);font-family:var(--fb);font-size:0.8rem;outline:none;transition:border-color 0.12s;width:100%;}
.aff input:focus,.aff select:focus,.aff textarea:focus{border-color:var(--ac);}
.aff textarea{resize:vertical;min-height:72px;line-height:1.55;}
.aff select option{background:var(--s2);color:var(--tx);}
.claim-action-row{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;align-items:center;}
.denial-badge{background:rgba(239,68,68,0.07);border:1px solid rgba(239,68,68,0.18);border-radius:7px;padding:6px 10px;font-size:0.67rem;color:var(--re);margin-top:5px;display:flex;gap:5px;align-items:flex-start;}
.success-flash{background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.22);border-radius:8px;padding:11px;margin-top:9px;animation:slideIn 0.25s ease;}
/* ── ADMIN PATIENT CLAIMS QUEUE ── */
.pcq-item{border:1px solid var(--bd);border-radius:10px;padding:12px;margin-bottom:9px;background:var(--bg);transition:border-color 0.15s;}
.pcq-item:hover{border-color:var(--b2);}
.pcq-item.pending{border-left:3px solid var(--or);}
.pcq-item.resolved{border-left:3px solid var(--gr);opacity:0.75;}
.pcq-header{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-bottom:7px;}
.pcq-body{font-size:0.73rem;color:var(--mu);line-height:1.6;margin-bottom:9px;}
.pcq-actions{display:flex;gap:7px;flex-wrap:wrap;align-items:center;}
.pcq-notes-input{background:var(--s2);border:1px solid var(--bd);border-radius:6px;padding:6px 9px;color:var(--tx);font-size:0.75rem;font-family:var(--fb);outline:none;flex:1;min-width:150px;}
.pcq-notes-input:focus{border-color:var(--ac);}
.empty-state{text-align:center;padding:36px 20px;color:var(--mu);}
.empty-icon{font-size:2rem;margin-bottom:9px;opacity:0.4;}
.portal-tabs{display:flex;gap:3px;background:var(--bg);border-radius:9px;padding:3px;margin-bottom:14px;border:1px solid var(--bd);}
.ptab{flex:1;text-align:center;padding:7px 10px;border-radius:6px;font-size:0.74rem;font-weight:600;cursor:pointer;color:var(--mu);transition:all 0.12s;}
.ptab.active{background:var(--s3);color:var(--ac);border:1px solid rgba(0,204,255,0.18);}
/* ── ADMIN LIVE NOTIFICATION BANNER ── */
.notif-banner{display:flex;align-items:center;gap:9px;background:rgba(0,0,0,0.3);border-bottom:1px solid var(--bd);padding:7px 23px;font-size:0.73rem;flex-wrap:wrap;animation:fadeInDown 0.22s ease;}
.notif-item{display:flex;align-items:center;gap:6px;padding:4px 11px;border-radius:7px;cursor:pointer;transition:all 0.12s;font-weight:600;font-size:0.7rem;}
.notif-approved{background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.25);color:var(--gr);}
.notif-denied{background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.25);color:var(--re);}
.notif-review{background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.25);color:var(--am);}
.notif-item:hover{opacity:0.82;transform:translateY(-1px);}
.notif-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0;animation:pulse 1.5s infinite;}
@keyframes fadeInDown{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
@media(max-width:900px){.g4{grid-template-columns:1fr 1fr;}.g2,.g3{grid-template-columns:1fr;}}
`;

// ═══════════════════════════════════════════════════════
// SHARED UI
// ═══════════════════════════════════════════════════════
function RtBadge() { return <div className="rt"><div className="dl"/>Real-time</div>; }

function Steps({ steps }) {
  const ref = useRef(null);
  useEffect(()=>{if(ref.current) ref.current.scrollTop=ref.current.scrollHeight;},[steps]);
  if(!steps.length) return null;
  return (
    <div className="steps-wrap" ref={ref}>
      {steps.map((s,i)=>(
        <div className="step" key={i}>
          <span style={{fontSize:"0.7rem",flexShrink:0}}>{s.done?"✓":"›"}</span>
          <span className={`step-text ${s.done?"step-done":"step-run"}`}>{s.text}</span>
        </div>
      ))}
    </div>
  );
}

function PatientPanel({ p }) {
  if(!p) return null;
  const initials = p.name.split(" ").map(n=>n[0]).join("");
  const rc = p.riskScore>70?"var(--re)":p.riskScore>40?"var(--am)":"var(--gr)";
  return (
    <>
      <div className="card">
        <div className="ptcard">
          <div className="ptav">{initials}</div>
          <div>
            <div className="ptn">{p.name}</div>
            <div className="ptid">{p.id} · {p.insurer}</div>
            <div className="pttags">
              <span className="tag tb">{p.age}y {p.gender}</span>
              <span className="tag tp">{p.bloodGroup}</span>
              <span className="tag ta">{p.primaryDiagnosis.name}</span>
              {p.flagged&&<span className="tag tr">🚩 Flagged</span>}
            </div>
          </div>
        </div>
      </div>
      <div className="g2">
        <div className="card">
          <div className="ct">Patient & Insurance</div>
          <div className="kv2">
            {[["DOB",p.dob],["Policy No",p.policyNo],["Member ID",p.memberId],["Deductible",`$${p.deductible}`],["Ded. Met",`$${p.deductibleMet}`],["Copay",`$${p.copay}`]].map(([k,v])=>(
              <div className="kv" key={k}><div className="kvk">{k}</div><div className="kvv">{v}</div></div>
            ))}
          </div>
        </div>
        <div className="card">
          <div className="ct">Diagnosis & Disease</div>
          <div className="kv2">
            {[["ICD-10",p.primaryDiagnosis.icd10],["Diagnosis",p.primaryDiagnosis.name],["Severity",p.diagnosisSeverity],["Comorbidities",p.disease.comorbidities.join(", ")],["Medications",p.medications.join(", ")],["Allergies",p.allergies.join(", ")]].map(([k,v])=>(
              <div className="kv" key={k}><div className="kvk">{k}</div><div className="kvv">{v}</div></div>
            ))}
          </div>
        </div>
      </div>
      <div className="card">
        <div className="ct">Vitals <span className="ctb">Last: {p.lastVisit}</span></div>
        <div className="vitrow">
          {Object.entries(p.vitals).map(([l,v])=>(
            <div className="vitpill" key={l}><div className="vitl">{l}</div><div className="vitv">{v}</div></div>
          ))}
        </div>
        <div style={{marginTop:9}}>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:"0.63rem",color:"var(--mu)",marginBottom:3}}>
            <span>Risk Score</span><span style={{color:rc,fontWeight:700}}>{p.riskScore}/100</span>
          </div>
          <div className="rbar"><div className="rfill" style={{width:`${p.riskScore}%`,background:rc}}/></div>
        </div>
      </div>
    </>
  );
}

function PatientSelector({ selected, onSelect }) {
  const [s,setS] = useState("");
  const list = DB_PATIENTS.filter(p=>
    p.name.toLowerCase().includes(s.toLowerCase())||
    p.id.includes(s)||
    p.primaryDiagnosis.name.toLowerCase().includes(s.toLowerCase())
  );
  return (
    <div className="ptselector">
      <div className="pts-hdr">
        <span style={{fontFamily:"var(--fh)",fontSize:"0.67rem",fontWeight:700,color:"var(--mu)",textTransform:"uppercase",letterSpacing:1}}>Select Patient <span style={{color:"var(--ac)",fontWeight:400}}>({DB_PATIENTS.length})</span></span>
        <RtBadge/>
      </div>
      <input className="dbsearch" style={{marginBottom:8}} placeholder="Search by name, ID or diagnosis…" value={s} onChange={e=>setS(e.target.value)}/>
      <div className="ptgrid">
        {list.slice(0,18).map(p=>(
          <div key={p.id} className={`ptchip ${selected?.id===p.id?"sel":""} ${p.flagged?"flag":""}`} onClick={()=>onSelect(p)}>
            {p.flagged?"🚩 ":""}{p.name} <span style={{opacity:.5,fontSize:"0.6rem"}}>· {p.id}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// LOGIN
// ═══════════════════════════════════════════════════════
function LoginScreen({ onLogin }) {
  const [tab,setTab]=useState("admin");
  const [u,setU]=useState(""); const [pw,setPw]=useState(""); const [err,setErr]=useState("");

  function tryLogin() {
    const user = ALL_USERS.find(x=>x.username===u.trim()&&x.password===pw.trim());
    if(!user){setErr("Invalid credentials.");return;}
    if(tab==="admin"&&user.role!=="admin"){setErr("Use Patient login for patient accounts.");return;}
    if(tab==="patient"&&user.role!=="patient"){setErr("Use Admin login for admin access.");return;}
    onLogin(user);
  }

  return (
    <div className="login-wrap">
      <div className="login-box">
        <div className="login-logo">ClearPath AI</div>
        <div className="login-sub">Healthcare Revenue Cycle Platform</div>
        <div className="login-tabs">
          <div className={`ltab ${tab==="admin"?"active":""}`} onClick={()=>{setTab("admin");setErr("");}}>Admin</div>
          <div className={`ltab ${tab==="patient"?"active":""}`} onClick={()=>{setTab("patient");setErr("");}}>Patient / Client</div>
        </div>
        {tab==="admin"&&<div className="hint">Username: <b>admin</b> &nbsp; Password: <b>admin123</b><br/>Full access — all patients, all AI agents</div>}
        {tab==="patient"&&<div className="hint">Try: <b>priya1</b> / <b>pass1</b><br/>Also: <b>arjun2/pass2</b> · <b>meera3/pass3</b> · <b>rohan4/pass4</b><br/>Patients see only their own records</div>}
        <div className="lf"><label>Username</label><input value={u} onChange={e=>setU(e.target.value)} onKeyDown={e=>e.key==="Enter"&&tryLogin()} placeholder={tab==="admin"?"admin":"e.g. priya1"} autoFocus/></div>
        <div className="lf"><label>Password</label><input type="password" value={pw} onChange={e=>setPw(e.target.value)} onKeyDown={e=>e.key==="Enter"&&tryLogin()} placeholder="••••••••"/></div>
        {err&&<div className="lerr">{err}</div>}
        <button className="btn btnp" style={{width:"100%",justifyContent:"center",marginTop:4}} onClick={tryLogin}>
          {tab==="admin"?"⚡ Admin Login":"→ Patient Login"}
        </button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// ADMIN PAGES
// ═══════════════════════════════════════════════════════
function AdminDashboard({ auditLog, patientClaims, onGoToQueue }) {
  const weekBars=[62,78,55,90,83,71,88]; const wl=["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
  const pr=[{n:"UnitedHealth",r:82,c:"#00ccff"},{n:"Anthem BCBS",r:74,c:"#8b5cf6"},{n:"Aetna",r:79,c:"#10b981"},{n:"Cigna",r:68,c:"#f59e0b"},{n:"Humana",r:71,c:"#ec4899"}];

  // Live patient claim stats — update whenever patientClaims changes
  const clmTotal    = patientClaims.length;
  const clmApproved = patientClaims.filter(c=>c.status==="APPROVED").length;
  const clmDenied   = patientClaims.filter(c=>c.status==="DENIED").length;
  const clmReview   = patientClaims.filter(c=>c.status==="NEEDS_REVIEW").length;
  const clmApprovalRate = clmTotal > 0 ? Math.round((clmApproved/clmTotal)*100) : 0;

  // Most recent 8 events merged (patient claims + audit blocks), newest first
  const feed = [
    ...patientClaims.map(c=>({
      ts: new Date(c.timestamp),
      text:`${c.claimType==="NEW"?"New claim":c.claimType==="APPEAL"?"Appeal":"Re-submit"} — ${c.patientName} · CPT ${c.cptCode}`,
      sub: c.status==="APPROVED"?`✓ Auto-Approved · $${(c.allowed_amount||0).toLocaleString()} allowed`:
           c.status==="DENIED"  ?`✗ Auto-Denied · Score ${c.adjScore}/100`:
           `⚠ Needs Manual Review · Score ${c.adjScore}/100`,
      color: c.status==="APPROVED"?"var(--gr)":c.status==="DENIED"?"var(--re)":"var(--am)",
      icon:"📬"
    })),
    ...auditLog.filter(b=>b.type!=="PATIENT_CLAIM").map(b=>({
      ts: new Date(b.timestamp),
      text:`${b.type} — ${b.patientName||"N/A"}`,
      sub:`→ ${b.decision||b.status||"Sealed"}`,
      color: b.decision==="APPROVED"?"var(--gr)":b.decision==="DENIED"?"var(--re)":"var(--am)",
      icon:"⛓"
    }))
  ].sort((a,b)=>b.ts-a.ts).slice(0,8);

  return (
    <div>
      <div className="g4" style={{marginBottom:13}}>
        {[
          {l:"Auth Turnaround",  v:"↓ 80%", s:"Days → Hours",         c:"green"},
          {l:"First-Pass Rate",  v:"↑ 35%", s:"Fewer denials",         c:"accent"},
          {l:"Audit Readiness",  v:"100%",  s:"Blockchain-sealed",      c:"green"},
          {l:"Needs Review",     v:clmReview, s:clmReview>0?"Awaiting admin":"All clear", c:clmReview>0?"amber":"green"}
        ].map(s=>(
          <div className="sc" key={s.l}><div className="sl">{s.l}</div><div className={`sv ${s.c}`}>{s.v}</div><div className="ss">{s.s}</div></div>
        ))}
      </div>

      {/* ── Live Patient Claim Stats — the key new section ── */}
      {clmTotal > 0 && (
        <div className="card" style={{marginBottom:13,cursor:"pointer"}} onClick={onGoToQueue}>
          <div className="ct">
            Patient Claim Auto-Adjudication
            <span className="ctb">{clmTotal} total</span>
            {clmReview>0&&<span className="ctba">{clmReview} need review</span>}
            <span style={{marginLeft:"auto",fontSize:"0.62rem",color:"var(--mu)"}}>Click to open queue →</span>
          </div>
          <div style={{display:"flex",gap:9,flexWrap:"wrap",marginBottom:11}}>
            {[
              {l:"Total Filed",  v:clmTotal,    c:"var(--ac)",  bg:"rgba(0,204,255,0.07)",  bc:"rgba(0,204,255,0.18)"},
              {l:"Auto-Approved",v:clmApproved, c:"var(--gr)",  bg:"rgba(16,185,129,0.07)", bc:"rgba(16,185,129,0.2)"},
              {l:"Auto-Denied",  v:clmDenied,   c:"var(--re)",  bg:"rgba(239,68,68,0.07)",  bc:"rgba(239,68,68,0.2)"},
              {l:"Needs Review", v:clmReview,   c:"var(--am)",  bg:"rgba(245,158,11,0.07)", bc:"rgba(245,158,11,0.2)"},
              {l:"Approval Rate",v:`${clmApprovalRate}%`, c:"var(--gr)", bg:"rgba(16,185,129,0.07)", bc:"rgba(16,185,129,0.18)"},
            ].map(s=>(
              <div key={s.l} style={{flex:1,minWidth:90,background:s.bg,border:`1px solid ${s.bc}`,borderRadius:8,padding:"9px 12px",textAlign:"center"}}>
                <div style={{fontSize:"0.58rem",color:"var(--mu)",textTransform:"uppercase",letterSpacing:"0.6px",marginBottom:4}}>{s.l}</div>
                <div style={{fontFamily:"var(--fh)",fontSize:"1.1rem",fontWeight:800,color:s.c}}>{s.v}</div>
              </div>
            ))}
          </div>
          {/* Approval/Denial bar */}
          <div style={{marginBottom:4,display:"flex",justifyContent:"space-between",fontSize:"0.6rem",color:"var(--mu)"}}>
            <span>Auto-decision breakdown</span>
            <span>{clmApproved} approved · {clmDenied} denied · {clmReview} review</span>
          </div>
          <div style={{height:6,background:"var(--bd)",borderRadius:4,overflow:"hidden",display:"flex"}}>
            {clmApproved>0&&<div style={{width:`${(clmApproved/clmTotal)*100}%`,background:"var(--gr)",transition:"width 0.5s ease"}}/>}
            {clmReview>0 &&<div style={{width:`${(clmReview /clmTotal)*100}%`,background:"var(--am)",transition:"width 0.5s ease"}}/>}
            {clmDenied>0 &&<div style={{width:`${(clmDenied /clmTotal)*100}%`,background:"var(--re)",transition:"width 0.5s ease"}}/>}
          </div>
          {/* Recent patient submissions */}
          {patientClaims.length > 0 && (
            <div style={{marginTop:10}}>
              <div style={{fontSize:"0.6rem",color:"var(--mu)",textTransform:"uppercase",letterSpacing:"0.6px",marginBottom:5}}>Recent submissions</div>
              {[...patientClaims].reverse().slice(0,4).map((c,i)=>(
                <div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"4px 0",borderBottom:"1px solid var(--bd)"}}>
                  <div style={{width:6,height:6,borderRadius:"50%",background:c.status==="APPROVED"?"var(--gr)":c.status==="DENIED"?"var(--re)":"var(--am)",flexShrink:0}}/>
                  <div style={{flex:1,fontSize:"0.7rem"}}>{c.patientName} <span style={{color:"var(--mu)"}}>· {c.claimType} · CPT {c.cptCode}</span></div>
                  <span className={`tag ${c.status==="APPROVED"?"tg":c.status==="DENIED"?"tr":"ta"}`} style={{fontSize:"0.58rem"}}>
                    {c.status==="APPROVED"?"✓ Approved":c.status==="DENIED"?"✗ Denied":"⚠ Review"}
                  </span>
                  {c.adjScore!=null&&<span style={{fontFamily:"var(--fm)",fontSize:"0.6rem",color:"var(--mu)"}}>{c.adjScore}/100</span>}
                  <span style={{fontSize:"0.6rem",color:"var(--di)"}}>{new Date(c.timestamp).toLocaleTimeString()}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="g2">
        <div className="card"><div className="ct">Weekly Volume</div><div className="barchart">{weekBars.map((h,i)=><div className="bw" key={i}><div className="bar" style={{height:`${h}%`}}/><div className="bl">{wl[i]}</div></div>)}</div></div>
        <div className="card"><div className="ct">Approval Rate by Payer</div>{pr.map(p=><div className="prow" key={p.n}><div style={{flex:1,fontSize:"0.75rem"}}>{p.n}</div><div className="pbar"><div className="pf" style={{width:`${p.r}%`,background:p.c}}/></div><div style={{fontSize:"0.7rem",fontFamily:"var(--fm)",width:34,textAlign:"right",color:p.c}}>{p.r}%</div></div>)}</div>
      </div>
      <div className="g2">
        <div className="card">
          <div className="ct">Live Activity <span className="ctb">{auditLog.length} blocks</span></div>
          {feed.length===0
            ?<div style={{color:"var(--mu)",fontSize:"0.75rem"}}>Run auth or claims to see events.</div>
            :feed.map((f,i)=>(
              <div className="feeditem" key={i}>
                <div className="fdot" style={{background:f.color}}/>
                <div>
                  <div style={{fontSize:"0.73rem"}}>{f.icon} {f.text}</div>
                  <div style={{fontSize:"0.63rem",color:f.color,marginTop:1,fontWeight:500}}>{f.sub}</div>
                  <div style={{fontSize:"0.59rem",color:"var(--di)",marginTop:1}}>{f.ts.toLocaleTimeString()}</div>
                </div>
              </div>
            ))}
        </div>
        <div className="card">
          <div className="ct">System Summary</div>
          {[
            {l:"Total Patients",     v:DB_PATIENTS.length,                                                           c:"var(--ac)"},
            {l:"Patient Submissions",v:clmTotal,                                                                     c:"var(--or)"},
            {l:"Auto-Approved",      v:clmApproved,                                                                  c:"var(--gr)"},
            {l:"Auto-Denied",        v:clmDenied,                                                                    c:"var(--re)"},
            {l:"Needs Review",       v:clmReview,                                                                    c:"var(--am)"},
            {l:"Flagged Records",    v:DB_PATIENTS.filter(p=>p.flagged).length,                                      c:"var(--re)"},
            {l:"Avg Risk Score",     v:(DB_PATIENTS.reduce((a,p)=>a+p.riskScore,0)/DB_PATIENTS.length).toFixed(1),  c:"var(--am)"},
            {l:"Audit Blocks",       v:auditLog.length,                                                              c:"var(--a2)"},
          ].map(r=>(
            <div className="prow" key={r.l}><div style={{flex:1,fontSize:"0.75rem",color:"var(--mu)"}}>{r.l}</div><div style={{fontFamily:"var(--fm)",fontSize:"0.85rem",fontWeight:700,color:r.c}}>{r.v}</div></div>
          ))}
        </div>
      </div>
    </div>
  );
}

function AdminAuth({ onSeal }) {
  const [patient,setPatient]=useState(null);
  const [result,setResult]=useState(null);
  const [steps,setSteps]=useState([]);
  const [running,setRunning]=useState(false);

  function run() {
    if(!patient||running) return;
    setRunning(true); setResult(null);
    setSteps([{text:`Scanning record: ${patient.id} — ${patient.name}`,done:false}]);
    setTimeout(()=>{
      setSteps([
        {text:`Record loaded — ${Object.keys(patient).length} fields found`,done:true},
        {text:`Agentic filter: selecting auth-relevant fields only…`,done:false},
      ]);
      setTimeout(()=>{
        setSteps([
          {text:`Record loaded`,done:true},
          {text:`Context optimized — auth segments extracted`,done:true},
          {text:`Running AI reasoning engine…`,done:false},
        ]);
        setTimeout(()=>{
          const ai = runPriorAuth(patient);
          const block = sealToChain({type:"PRIOR_AUTH",patientId:patient.id,patientName:patient.name,cpt:patient.requestedProcedure.code,insurer:patient.insurer,...ai});
          setResult({...ai,hash:block.hash,blockIndex:block.blockIndex});
          onSeal(block);
          setSteps(s=>[...s.slice(0,-1),{text:`Decision sealed → Block #${block.blockIndex} · ${block.hash}`,done:true}]);
          setRunning(false);
        },400);
      },350);
    },300);
  }

  const dc = result?.decision==="APPROVED"?"approved":result?.decision==="DENIED"?"denied":"review";
  return (
    <div>
      <PatientSelector selected={patient} onSelect={p=>{setPatient(p);setResult(null);setSteps([]);}}/>
      {patient&&<PatientPanel p={patient}/>}
      <Steps steps={steps}/>
      <div style={{display:"flex",gap:10,marginBottom:13,alignItems:"center"}}>
        <button className="btn btnp" onClick={run} disabled={running||!patient}>
          {running?"⏳ Processing…":"⚡ Run Prior Auth Agent"}
        </button>
        {patient&&<span style={{fontSize:"0.7rem",color:"var(--mu)"}}>→ {patient.requestedProcedure.name} ({patient.requestedProcedure.code}) · {patient.insurer}</span>}
      </div>
      {result&&(
        <div className="rbox">
          <div className="rh">
            <span className={`rd ${dc}`}>{result.decision==="APPROVED"?"✓":result.decision==="DENIED"?"✗":"⚠"} {result.decision}</span>
            <span className="hb">Block #{result.blockIndex} · {result.hash}</span>
          </div>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:"0.63rem",color:"var(--mu)",marginBottom:2}}><span>AI Confidence</span><span style={{color:"var(--ac)"}}>{result.confidence}%</span></div>
          <div className="cbar"><div className="cfill" style={{width:`${result.confidence}%`}}/></div>
          <div style={{fontSize:"0.61rem",color:"var(--mu)",marginBottom:5,textTransform:"uppercase",letterSpacing:"0.8px"}}>5-Step Reasoning Chain</div>
          <div className="reasoning">{result.reasoning}</div>
          {result.regulatory_basis&&<div style={{fontSize:"0.69rem",color:"var(--am)",marginTop:6}}>📜 {result.regulatory_basis}</div>}
          {result.decision==="DENIED"&&<div style={{fontSize:"0.69rem",color:"var(--ac)",marginTop:5}}>↩ {result.appeal_pathway}</div>}
        </div>
      )}
    </div>
  );
}

function AdminClaims({ onSeal }) {
  const [patient,setPatient]=useState(null);
  const [result,setResult]=useState(null);
  const [steps,setSteps]=useState([]);
  const [running,setRunning]=useState(false);

  function run() {
    if(!patient||running) return;
    setRunning(true); setResult(null);
    setSteps([{text:`Loading claims context for ${patient.id}…`,done:false}]);
    setTimeout(()=>{
      setSteps([
        {text:`Claims context loaded`,done:true},
        {text:`Running NCCI bundling check + fraud analysis…`,done:false},
      ]);
      setTimeout(()=>{
        const ai = runClaims(patient);
        const block = sealToChain({type:"CLAIM",patientId:patient.id,patientName:patient.name,cpt:patient.requestedProcedure.code,...ai});
        setResult({...ai,hash:block.hash,blockIndex:block.blockIndex});
        onSeal(block);
        setSteps([
          {text:`Claims context loaded`,done:true},
          {text:`NCCI: ${ai.ncci_check} · Fraud score: ${ai.fraud_score}/100`,done:true},
          {text:`Sealed → Block #${block.blockIndex} · ${block.hash}`,done:true},
        ]);
        setRunning(false);
      },500);
    },300);
  }

  return (
    <div>
      <PatientSelector selected={patient} onSelect={p=>{setPatient(p);setResult(null);setSteps([]);}}/>
      {patient&&<PatientPanel p={patient}/>}
      <Steps steps={steps}/>
      <div style={{display:"flex",gap:10,marginBottom:13,alignItems:"center"}}>
        <button className="btn btnp" onClick={run} disabled={running||!patient}>
          {running?"⏳ Adjudicating…":"⚡ Run Claims Engine"}
        </button>
        {patient&&<span style={{fontSize:"0.7rem",color:"var(--mu)"}}>→ ${patient.billedAmount.toFixed(0)} billed · {patient.requestedProcedure.code}</span>}
      </div>
      {result&&(
        <div className="rbox">
          <div className="rh">
            <span className={`rd ${result.decision==="APPROVED"?"approved":result.decision==="DENIED"?"denied":"review"}`}>{result.decision==="APPROVED"?"✓":result.decision==="DENIED"?"✗":"~"} {result.decision}</span>
            <span className="hb">Block #{result.blockIndex} · {result.hash}</span>
          </div>
          <div className="g3" style={{marginTop:9}}>
            {[["Allowed Amount",`$${result.allowed_amount?.toLocaleString()}`,"var(--gr)"],["NCCI Check",result.ncci_check,result.ncci_check==="PASS"?"var(--gr)":"var(--am)"],["Fraud Score",`${result.fraud_score}/100`,result.fraud_score>60?"var(--re)":"var(--gr)"]].map(([l,v,c])=>(
              <div key={l} style={{textAlign:"center",padding:9,background:"var(--bg)",borderRadius:7,border:"1px solid var(--bd)"}}>
                <div style={{fontSize:"0.6rem",color:"var(--mu)",marginBottom:3}}>{l}</div>
                <div style={{fontSize:"0.88rem",fontWeight:700,color:c,fontFamily:"var(--fh)"}}>{v}</div>
              </div>
            ))}
          </div>
          {result.notes&&<div className="reasoning" style={{marginTop:9}}>{result.notes}</div>}
        </div>
      )}
    </div>
  );
}

function AdminSim({ onSeal }) {
  const [patient,setPatient]=useState(null);
  const scenarios=[
    {id:1,title:"Aetna tightens MRI auth requirements",desc:"All MRI requests need 6-week conservative treatment documentation"},
    {id:2,title:"CMS expands telehealth CPT coverage",desc:"99213 covered for remote monitoring without prior auth"},
    {id:3,title:"UnitedHealth adds step-therapy for knee replacement",desc:"27447 requires 3-month PT documentation before approval"},
  ];
  const [sel,setSel]=useState(null);
  const [result,setResult]=useState(null);
  const [steps,setSteps]=useState([]);
  const [running,setRunning]=useState(false);

  function simulate() {
    if(!sel||running) return;
    setRunning(true); setResult(null);
    setSteps([{text:patient?`Simulating impact on ${patient.name}…`:"Simulating across all patients…",done:false}]);
    setTimeout(()=>{
      const ai = runPolicySim(sel, patient);
      const block = sealToChain({type:"POLICY_SIM",scenario:sel.title,patientId:patient?.id,patientName:patient?.name,...ai});
      setResult({...ai,hash:block.hash,blockIndex:block.blockIndex});
      onSeal(block);
      setSteps([
        {text:`Policy scenario analyzed — ${ai.risk_level} risk`,done:true},
        {text:`Sealed → Block #${block.blockIndex} · ${block.hash}`,done:true},
      ]);
      setRunning(false);
    },600);
  }

  return (
    <div>
      <PatientSelector selected={patient} onSelect={p=>{setPatient(p);setResult(null);setSteps([]);}}/>
      <div className="card">
        <div className="ct">Select Policy Scenario</div>
        <div style={{display:"flex",flexDirection:"column",gap:7,marginBottom:12}}>
          {scenarios.map(s=><div key={s.id} className={`sccard ${sel?.id===s.id?"sel":""}`} onClick={()=>{setSel(s);setResult(null);}}><div style={{fontSize:"0.78rem",fontWeight:600,marginBottom:2}}>{s.title}</div><div style={{fontSize:"0.69rem",color:"var(--mu)"}}>{s.desc}</div></div>)}
        </div>
        <button className="btn btnp" onClick={simulate} disabled={running||!sel}>{running?"⏳ Simulating…":"🧪 Run Simulation"}</button>
      </div>
      <Steps steps={steps}/>
      {result&&(
        <div className="rbox">
          <div className="rh">
            <span className={`rd ${result.risk_level==="LOW"?"approved":result.risk_level==="HIGH"?"denied":"review"}`}>Risk: {result.risk_level}</span>
            <span className="hb">Block #{result.blockIndex} · {result.hash}</span>
          </div>
          <div className="g2" style={{marginTop:9,gap:8}}>
            {[["Approval Rate Δ",result.approval_rate_delta,"var(--re)"],["Financial Impact/1K",result.financial_impact,"var(--am)"]].map(([l,v,c])=>(
              <div key={l} style={{padding:9,background:"var(--bg)",borderRadius:7,border:"1px solid var(--bd)"}}>
                <div style={{fontSize:"0.6rem",color:"var(--mu)",marginBottom:3}}>{l}</div>
                <div style={{fontSize:"0.86rem",fontWeight:700,color:c}}>{v}</div>
              </div>
            ))}
          </div>
          <div className="reasoning" style={{marginTop:9}}>{`CPT Codes Affected: ${result.affected_cpt_codes?.join(", ")}\n\nWorkflow Changes: ${result.workflow_changes}\n\nRecommendation: ${result.recommendation}`}</div>
        </div>
      )}
    </div>
  );
}

function AdminDB() {
  const [tab,setTab]=useState("patients");
  const [s,setS]=useState("");
  const [exp,setExp]=useState(null);
  const fp=DB_PATIENTS.filter(p=>p.name.toLowerCase().includes(s.toLowerCase())||p.id.includes(s)||p.insurer.toLowerCase().includes(s.toLowerCase()));
  const fd=DISEASES.filter(d=>d.name.toLowerCase().includes(s.toLowerCase())||d.icd10.includes(s));
  const fc=CPT_LIST.filter(c=>c.name.toLowerCase().includes(s.toLowerCase())||c.code.includes(s));
  const rc=v=>v>70?"var(--re)":v>40?"var(--am)":"var(--gr)";
  return (
    <div>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:11}}>
        <RtBadge/>
        <span style={{fontSize:"0.65rem",color:"var(--mu)"}}>{DB_PATIENTS.length} patients · {DISEASES.length} diseases · {CPT_LIST.length} procedures</span>
      </div>
      <input className="dbsearch" placeholder={`Search ${tab}…`} value={s} onChange={e=>setS(e.target.value)}/>
      <div className="dbtabs">
        {[{id:"patients",l:`Patients (${DB_PATIENTS.length})`},{id:"diseases",l:`Diseases (${DISEASES.length})`},{id:"cpt",l:`CPT (${CPT_LIST.length})`}].map(t=>(
          <div key={t.id} className={`dbt ${tab===t.id?"active":""}`} onClick={()=>{setTab(t.id);setS("");setExp(null);}}>{t.l}</div>
        ))}
      </div>
      {tab==="patients"&&(
        <div className="scroll">
          <table className="dbt2">
            <thead><tr><th>ID</th><th>Name</th><th>Age</th><th>Insurer</th><th>Diagnosis</th><th>CPT</th><th>Risk</th><th>Auth</th><th>Claim</th></tr></thead>
            <tbody>
              {fp.map(p=>(
                <>
                  <tr key={p.id} style={{cursor:"pointer"}} onClick={()=>setExp(exp===p.id?null:p.id)}>
                    <td><span style={{fontFamily:"var(--fm)",fontSize:"0.66rem",color:"var(--ac)"}}>{p.id}</span></td>
                    <td><strong>{p.name}</strong>{p.flagged&&<span className="tag tr" style={{marginLeft:5,fontSize:"0.57rem"}}>🚩</span>}</td>
                    <td style={{color:"var(--mu)",fontSize:"0.71rem"}}>{p.age}y</td>
                    <td style={{fontSize:"0.71rem"}}>{p.insurer}</td>
                    <td><span className="tag ta" style={{fontSize:"0.59rem"}}>{p.primaryDiagnosis.icd10}</span></td>
                    <td style={{fontSize:"0.69rem",color:"var(--mu)"}}>{p.requestedProcedure.code}</td>
                    <td><span style={{color:rc(p.riskScore),fontFamily:"var(--fm)",fontWeight:700,fontSize:"0.77rem"}}>{p.riskScore}</span></td>
                    <td><span className={`tag ${p.authStatus==="APPROVED"?"tg":p.authStatus==="DENIED"?"tr":"ta"}`} style={{fontSize:"0.59rem"}}>{p.authStatus}</span></td>
                    <td><span className={`tag ${p.claimStatus==="PAID"||p.claimStatus==="APPROVED"?"tg":p.claimStatus==="DENIED"?"tr":"ta"}`} style={{fontSize:"0.59rem"}}>{p.claimStatus}</span></td>
                  </tr>
                  {exp===p.id&&(
                    <tr key={`${p.id}-e`} className="exprow">
                      <td colSpan={9}>
                        <div className="expinner">
                          <div className="g3" style={{gap:10}}>
                            <div>
                              <div style={{fontSize:"0.59rem",color:"var(--ac)",marginBottom:6,fontWeight:700,textTransform:"uppercase"}}>Patient</div>
                              {[["DOB",p.dob],["Blood",p.bloodGroup],["Phone",p.phone],["Occupation",p.occupation]].map(([k,v])=>(
                                <div key={k} style={{display:"flex",gap:6,marginBottom:3}}><span style={{fontSize:"0.61rem",color:"var(--mu)",width:70,flexShrink:0}}>{k}</span><span style={{fontSize:"0.67rem"}}>{v}</span></div>
                              ))}
                            </div>
                            <div>
                              <div style={{fontSize:"0.59rem",color:"var(--a2)",marginBottom:6,fontWeight:700,textTransform:"uppercase"}}>Insurance</div>
                              {[["Policy",p.policyNo],["Member",p.memberId],["Deductible",`$${p.deductible}`],["Billed",`$${p.billedAmount.toFixed(0)}`]].map(([k,v])=>(
                                <div key={k} style={{display:"flex",gap:6,marginBottom:3}}><span style={{fontSize:"0.61rem",color:"var(--mu)",width:70,flexShrink:0}}>{k}</span><span style={{fontSize:"0.67rem"}}>{v}</span></div>
                              ))}
                            </div>
                            <div>
                              <div style={{fontSize:"0.59rem",color:"var(--gr)",marginBottom:6,fontWeight:700,textTransform:"uppercase"}}>Disease & Vitals</div>
                              {[["Diagnosis",p.primaryDiagnosis.name],["Meds",p.medications.join(", ")],["BP",p.vitals.bp],["BMI",p.vitals.bmi]].map(([k,v])=>(
                                <div key={k} style={{display:"flex",gap:6,marginBottom:3}}><span style={{fontSize:"0.61rem",color:"var(--mu)",width:70,flexShrink:0}}>{k}</span><span style={{fontSize:"0.67rem"}}>{v}</span></div>
                              ))}
                            </div>
                          </div>
                          <div style={{marginTop:9}}>
                            <div style={{fontSize:"0.59rem",color:"var(--am)",marginBottom:5,fontWeight:700,textTransform:"uppercase"}}>Claim History</div>
                            <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                              {p.claimHistory.map(c=>(
                                <div key={c.claimId} style={{background:"var(--s2)",border:"1px solid var(--bd)",borderRadius:6,padding:"3px 8px",fontSize:"0.62rem"}}>
                                  <span style={{color:"var(--mu)"}}>{c.claimId} · {c.date} · </span>
                                  <span style={{color:"var(--tx)"}}>${c.amount} · </span>
                                  <span style={{color:c.status==="APPROVED"||c.status==="PAID"?"var(--gr)":c.status==="DENIED"?"var(--re)":"var(--am)"}}>{c.status}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {tab==="diseases"&&<div className="scroll"><table className="dbt2"><thead><tr><th>ICD-10</th><th>Name</th><th>Category</th><th>Severity</th><th>Treatments</th><th>Comorbidities</th></tr></thead><tbody>{fd.map(d=><tr key={d.icd10}><td><span style={{fontFamily:"var(--fm)",color:"var(--ac)"}}>{d.icd10}</span></td><td><strong>{d.name}</strong></td><td><span className="tag tp">{d.category}</span></td><td><span className={`tag ${d.severity==="Acute"?"ta":"tr"}`}>{d.severity}</span></td><td style={{fontSize:"0.68rem",color:"var(--mu)"}}>{d.treatments.join(" · ")}</td><td style={{fontSize:"0.68rem",color:"var(--mu)"}}>{d.comorbidities.join(", ")}</td></tr>)}</tbody></table></div>}
      {tab==="cpt"&&<div className="scroll"><table className="dbt2"><thead><tr><th>Code</th><th>Name</th><th>Category</th><th>Avg Cost</th><th>Auth Required</th></tr></thead><tbody>{fc.map(c=><tr key={c.code}><td><span style={{fontFamily:"var(--fm)",color:"var(--ac)"}}>{c.code}</span></td><td><strong>{c.name}</strong></td><td><span className="tag tb">{c.category}</span></td><td style={{fontFamily:"var(--fm)",color:"var(--gr)"}}>${c.avgCost.toLocaleString()}</td><td>{c.requiresAuth?<span className="tag tr">Required</span>:<span className="tag tg">Not Required</span>}</td></tr>)}</tbody></table></div>}
    </div>
  );
}

function AdminAudit({ log }) {
  return (
    <div>
      {log.length===0?<div className="card" style={{color:"var(--mu)",fontSize:"0.77rem",textAlign:"center",padding:28}}>No blocks yet. Run auth or claims to generate entries.</div>:(
        <div className="scroll">
          {[...log].reverse().map((b,i)=>(
            <div className="audit-item" key={i}>
              <div style={{display:"flex",alignItems:"center",gap:9,flexWrap:"wrap",marginBottom:5}}>
                <span style={{fontFamily:"var(--fm)",fontSize:"0.62rem",color:"var(--mu)"}}>Block #{b.blockIndex}</span>
                <span className={`rd ${b.decision==="APPROVED"||b.decision==="APPEAL_ACCEPTED"||b.decision==="RESEND_PROCESSED"?"approved":b.decision==="DENIED"?"denied":b.type?.includes("PATIENT")?"pending-r":"review"}`} style={{fontSize:"0.62rem",padding:"1px 7px"}}>{b.decision||b.type}</span>
                <span style={{fontSize:"0.65rem",color:"var(--mu)"}}>{new Date(b.timestamp).toLocaleString()}</span>
                {b.patientName&&<span style={{fontSize:"0.67rem",color:"var(--tx)"}}>{b.patientName} · {b.patientId}</span>}
                {b.type==="PATIENT_CLAIM"&&<span className="tag tor" style={{fontSize:"0.57rem"}}>📬 Patient Submitted</span>}
              </div>
              <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                <span style={{fontFamily:"var(--fm)",fontSize:"0.58rem",color:"var(--ac)"}}>HASH: {b.hash}</span>
                <span style={{fontFamily:"var(--fm)",fontSize:"0.58rem",color:"var(--mu)"}}>PREV: {b.prevHash}</span>
                {b.claimType&&<span style={{fontSize:"0.6rem",color:"var(--or)"}}>TYPE: {b.claimType}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// ADMIN — PATIENT CLAIMS QUEUE
// ═══════════════════════════════════════════════════════
function AdminPatientClaims({ patientClaims, onResolve, onMount }) {
  const [filter, setFilter] = useState("ALL");
  // Mark all claims as seen the moment admin opens this page
  useEffect(()=>{ if(onMount) onMount(); }, []);
  const [noteInputs, setNoteInputs] = useState({});
  const [resolving, setResolving] = useState(null);
  const [expanded, setExpanded] = useState(null);

  const isAutoResolved = c => c.status === "APPROVED" || c.status === "DENIED";
  const isPending      = c => c.status === "NEEDS_REVIEW";

  const filtered = patientClaims.filter(c => {
    if (filter === "PENDING")      return isPending(c);
    if (filter === "AUTO_APPROVED") return c.status === "APPROVED" && !c.adminNote;
    if (filter === "AUTO_DENIED")   return c.status === "DENIED"   && !c.adminNote;
    if (filter === "MANUAL")       return !!c.adminNote;
    return true;
  }).slice().reverse();

  function handleResolve(claim, newStatus) {
    setResolving(claim.id);
    setTimeout(() => {
      onResolve(claim.id, newStatus, noteInputs[claim.id] || "");
      setResolving(null);
    }, 400);
  }

  const typeLabel  = { NEW:"New Claim", APPEAL:"Appeal", RESEND:"Re-submission" };
  const typeClass  = { NEW:"tb", APPEAL:"tor", RESEND:"tp" };
  const statusCls  = s =>
    s==="APPROVED"?"tg" : s==="DENIED"?"tr" : s==="NEEDS_REVIEW"?"ta" : s==="MORE_INFO_NEEDED"?"tp" : "ta";

  const counts = {
    all:      patientClaims.length,
    pending:  patientClaims.filter(isPending).length,
    approved: patientClaims.filter(c=>c.status==="APPROVED").length,
    denied:   patientClaims.filter(c=>c.status==="DENIED").length,
    manual:   patientClaims.filter(c=>!!c.adminNote).length,
  };

  return (
    <div>
      {/* Stats row */}
      <div className="g4" style={{marginBottom:13}}>
        {[
          {l:"Total Submissions", v:counts.all,      c:"var(--ac)"},
          {l:"Auto-Approved",     v:counts.approved,  c:"var(--gr)"},
          {l:"Auto-Denied",       v:counts.denied,    c:"var(--re)"},
          {l:"Needs Review",      v:counts.pending,   c:"var(--am)"},
        ].map(s=>(
          <div className="sc" key={s.l}>
            <div className="sl">{s.l}</div>
            <div className="sv" style={{color:s.c,fontSize:"1.5rem"}}>{s.v}</div>
          </div>
        ))}
      </div>

      <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:13,flexWrap:"wrap"}}>
        <RtBadge/>
        {counts.pending > 0 && (
          <div style={{display:"flex",alignItems:"center",gap:6,background:"rgba(245,158,11,0.08)",border:"1px solid rgba(245,158,11,0.22)",borderRadius:8,padding:"5px 11px"}}>
            <div style={{width:7,height:7,borderRadius:"50%",background:"var(--am)",animation:"pulse 1.5s infinite"}}/>
            <span style={{fontSize:"0.72rem",color:"var(--am)",fontWeight:600}}>{counts.pending} claim{counts.pending>1?"s":""} need manual review</span>
          </div>
        )}
        <div style={{marginLeft:"auto",display:"flex",gap:4,flexWrap:"wrap"}}>
          {[["ALL","All",counts.all],["PENDING","Review",counts.pending],["AUTO_APPROVED","Approved",counts.approved],["AUTO_DENIED","Denied",counts.denied]].map(([f,l,n])=>(
            <button key={f} className="btns" style={{padding:"4px 10px",fontSize:"0.68rem",background:filter===f?"rgba(0,204,255,0.07)":"transparent",color:filter===f?"var(--ac)":"var(--mu)",borderColor:filter===f?"rgba(0,204,255,0.3)":"var(--bd)"}} onClick={()=>setFilter(f)}>{l} ({n})</button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">📭</div>
          <div style={{fontSize:"0.8rem",fontWeight:600,marginBottom:5}}>No {filter!=="ALL"?filter.toLowerCase().replace("_"," ")+" ":""} submissions</div>
          <div style={{fontSize:"0.71rem",color:"var(--di)"}}>Patient claims auto-adjudicated and synced here in real-time.</div>
        </div>
      ) : filtered.map(c => {
        const needsManual = isPending(c) && !c.adminNote;
        const autoApproved = c.status==="APPROVED" && !c.adminNote;
        const autoDenied   = c.status==="DENIED"   && !c.adminNote;
        const isExpanded   = expanded === c.id;

        return (
          <div key={c.id} className={`pcq-item ${needsManual?"pending":"resolved"}`}
            style={{borderLeftColor: autoApproved?"var(--gr)": autoDenied?"var(--re)": needsManual?"var(--am)":"var(--b2)"}}>

            {/* Header row */}
            <div className="pcq-header" style={{cursor:"pointer"}} onClick={()=>setExpanded(isExpanded?null:c.id)}>
              <span className={`tag ${typeClass[c.claimType]||"tb"}`}>{typeLabel[c.claimType]||c.claimType}</span>
              <span className={`tag ${statusCls(c.status)}`}>
                {c.status==="APPROVED"&&!c.adminNote?"✓ Auto-Approved":
                 c.status==="DENIED"  &&!c.adminNote?"✗ Auto-Denied":
                 c.status==="NEEDS_REVIEW"?"⚠ Needs Review":
                 c.adminNote?"👤 Admin Resolved":c.status}
              </span>
              {/* Score pill */}
              {c.adjScore != null && (
                <span style={{fontFamily:"var(--fm)",fontSize:"0.63rem",color:c.adjScore>=75?"var(--gr)":c.adjScore>=50?"var(--am)":"var(--re)",background:c.adjScore>=75?"rgba(16,185,129,0.08)":c.adjScore>=50?"rgba(245,158,11,0.08)":"rgba(239,68,68,0.08)",border:`1px solid ${c.adjScore>=75?"rgba(16,185,129,0.18)":c.adjScore>=50?"rgba(245,158,11,0.18)":"rgba(239,68,68,0.18)"}`,borderRadius:5,padding:"1px 7px"}}>
                  Score {c.adjScore}/100
                </span>
              )}
              <span style={{fontFamily:"var(--fm)",fontSize:"0.65rem",color:"var(--ac)",fontWeight:700}}>{c.patientName}</span>
              <span style={{fontSize:"0.62rem",color:"var(--mu)"}}>{c.patientId}</span>
              {c.referenceClaimId&&<span style={{fontFamily:"var(--fm)",fontSize:"0.6rem",color:"var(--mu)"}}>ref:{c.referenceClaimId}</span>}
              <span style={{marginLeft:"auto",fontSize:"0.61rem",color:"var(--di)"}}>{new Date(c.timestamp).toLocaleString()}</span>
              <span style={{fontSize:"0.65rem",color:"var(--mu)"}}>{isExpanded?"▲":"▼"}</span>
            </div>

            {/* Summary row always visible */}
            <div style={{display:"flex",gap:14,flexWrap:"wrap",fontSize:"0.72rem",marginTop:5,marginBottom:4}}>
              <span><span style={{color:"var(--mu)"}}>CPT </span><span style={{fontFamily:"var(--fm)",color:"var(--ac)"}}>{c.cptCode}</span></span>
              <span><span style={{color:"var(--mu)"}}>Billed </span><span style={{color:"var(--tx)"}}>${Number(c.billedAmount).toLocaleString()}</span></span>
              {c.allowed_amount!=null&&<span><span style={{color:"var(--mu)"}}>Allowed </span><span style={{color:c.status==="APPROVED"?"var(--gr)":"var(--re)"}}>${c.allowed_amount.toLocaleString()}</span></span>}
              <span><span style={{color:"var(--mu)"}}>Insurer </span>{c.insurer}</span>
              {c.passedCount!=null&&<span><span style={{color:"var(--mu)"}}>Criteria </span><span style={{color:"var(--ac)"}}>{c.passedCount}/{c.totalCount} passed</span></span>}
            </div>

            {/* Expanded detail */}
            {isExpanded && (
              <div style={{borderTop:"1px solid var(--bd)",paddingTop:10,marginTop:5}}>

                {/* Criteria grid */}
                {c.criteria && c.criteria.length > 0 && (
                  <div style={{marginBottom:10}}>
                    <div style={{fontSize:"0.6rem",color:"var(--mu)",textTransform:"uppercase",letterSpacing:"0.7px",marginBottom:6}}>Adjudication Criteria Breakdown</div>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:4}}>
                      {c.criteria.map((cr,i)=>(
                        <div key={i} style={{display:"flex",gap:6,alignItems:"flex-start",padding:"4px 7px",background:cr.passed?"rgba(16,185,129,0.04)":"rgba(239,68,68,0.04)",borderRadius:5,border:`1px solid ${cr.passed?"rgba(16,185,129,0.1)":cr.critical?"rgba(239,68,68,0.28)":"rgba(239,68,68,0.1)"}`}}>
                          <span style={{fontSize:"0.7rem",flexShrink:0}}>{cr.passed?"✓":"✗"}</span>
                          <div>
                            <div style={{fontSize:"0.65rem",fontWeight:600,color:cr.passed?"var(--gr)":cr.critical?"var(--re)":"var(--am)"}}>{cr.label}{cr.critical&&!cr.passed&&" ⚡"}</div>
                            <div style={{fontSize:"0.6rem",color:"var(--mu)",lineHeight:1.4,marginTop:1}}>{cr.detail}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Patient statement */}
                {c.issueDescription&&(
                  <div style={{background:"var(--s2)",borderRadius:6,padding:"6px 9px",marginBottom:7}}>
                    <div style={{fontSize:"0.59rem",color:"var(--mu)",textTransform:"uppercase",marginBottom:2}}>Patient Statement</div>
                    <div style={{fontSize:"0.72rem",lineHeight:1.6}}>{c.issueDescription}</div>
                  </div>
                )}
                {c.additionalNotes&&(
                  <div style={{background:"var(--s2)",borderRadius:6,padding:"6px 9px",marginBottom:7}}>
                    <div style={{fontSize:"0.59rem",color:"var(--mu)",textTransform:"uppercase",marginBottom:2}}>Supporting Documentation</div>
                    <div style={{fontSize:"0.72rem",lineHeight:1.6}}>{c.additionalNotes}</div>
                  </div>
                )}

                {/* AI decision note */}
                {c.autoNote&&(
                  <div style={{background:"rgba(0,204,255,0.04)",border:"1px solid rgba(0,204,255,0.11)",borderRadius:6,padding:"6px 9px",marginBottom:7}}>
                    <div style={{fontSize:"0.59rem",color:"var(--ac)",textTransform:"uppercase",marginBottom:2}}>Auto-Adjudication Note · Confidence {c.aiConfidence}%</div>
                    <div style={{fontSize:"0.69rem",color:"#6a9fbe",lineHeight:1.6}}>{c.autoNote}</div>
                  </div>
                )}
                {c.regulatory_basis&&<div style={{fontSize:"0.63rem",color:"var(--di)",marginBottom:8}}>📜 {c.regulatory_basis}</div>}

                {/* Admin resolved note */}
                {c.adminNote&&(
                  <div style={{background:"rgba(16,185,129,0.05)",border:"1px solid rgba(16,185,129,0.15)",borderRadius:6,padding:"6px 9px",marginBottom:7,fontSize:"0.71rem",color:"var(--gr)"}}>
                    <span style={{fontSize:"0.59rem",textTransform:"uppercase",opacity:0.7,marginRight:5}}>Admin Note:</span>{c.adminNote}
                    {c.resolvedAt&&<span style={{fontSize:"0.6rem",color:"var(--di)",marginLeft:8}}>{new Date(c.resolvedAt).toLocaleString()}</span>}
                  </div>
                )}
              </div>
            )}

            {/* Manual review actions — only for NEEDS_REVIEW without admin action yet */}
            {needsManual && (
              <div className="pcq-actions" style={{marginTop:8,paddingTop:8,borderTop:"1px solid var(--bd)"}}>
                <input
                  className="pcq-notes-input"
                  placeholder="Add resolution note (required for override)…"
                  value={noteInputs[c.id]||""}
                  onChange={e=>setNoteInputs(p=>({...p,[c.id]:e.target.value}))}
                />
                <button className="btng" onClick={()=>handleResolve(c,"APPROVED")} disabled={resolving===c.id}>
                  {resolving===c.id?"…":"✓ Approve"}
                </button>
                <button className="btns" onClick={()=>handleResolve(c,"MORE_INFO_NEEDED")} disabled={resolving===c.id}>
                  ? Need Info
                </button>
                <button className="btnd" onClick={()=>handleResolve(c,"DENIED")} disabled={resolving===c.id}>
                  ✗ Deny
                </button>
              </div>
            )}

            {/* Override option for auto-resolved — admin can still override */}
            {(autoApproved || autoDenied) && isExpanded && (
              <div style={{marginTop:8,paddingTop:8,borderTop:"1px solid var(--bd)"}}>
                <div style={{fontSize:"0.62rem",color:"var(--di)",marginBottom:6}}>
                  ⬆ Admin override — this was auto-{c.status.toLowerCase()}. You may override if needed.
                </div>
                <div className="pcq-actions">
                  <input
                    className="pcq-notes-input"
                    placeholder="Override reason (required)…"
                    value={noteInputs[c.id]||""}
                    onChange={e=>setNoteInputs(p=>({...p,[c.id]:e.target.value}))}
                  />
                  {autoDenied&&<button className="btng" onClick={()=>handleResolve(c,"APPROVED")} disabled={!noteInputs[c.id]||resolving===c.id}>↑ Override Approve</button>}
                  {autoApproved&&<button className="btnd" onClick={()=>handleResolve(c,"DENIED")} disabled={!noteInputs[c.id]||resolving===c.id}>↓ Override Deny</button>}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// PATIENT PORTAL — CLAIM FORM  (auto-adjudication)
// ═══════════════════════════════════════════════════════
function PatientClaimForm({ p, onSubmitClaim }) {
  const [claimType, setClaimType] = useState("NEW");
  const [referenceClaimId, setReferenceClaimId] = useState("");
  const [cptCode, setCptCode] = useState(p.requestedProcedure.code);
  const [billedAmount, setBilledAmount] = useState(p.billedAmount.toFixed(0));
  const [issueDescription, setIssueDescription] = useState("");
  const [additionalNotes, setAdditionalNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [adjSteps, setAdjSteps] = useState([]);
  const [submitted, setSubmitted] = useState(null);

  const deniedClaims = p.claimHistory.filter(c=>c.status==="DENIED");

  function submit() {
    if (!issueDescription.trim()) return;
    setSubmitting(true);
    setAdjSteps([{text:"Validating CPT–ICD-10 alignment…",done:false}]);
    setTimeout(()=>{
      setAdjSteps([
        {text:"CPT–ICD-10 alignment checked",done:true},
        {text:"Running fraud & risk analysis…",done:false},
      ]);
      setTimeout(()=>{
        setAdjSteps(s=>[...s.slice(0,-1),{text:"Fraud & risk analysis complete",done:true},{text:"Checking authorization, billed amount, NCCI bundling…",done:false}]);
        setTimeout(()=>{
          const submission = {
            patientId: p.id, patientName: p.name, insurer: p.insurer,
            cptCode, billedAmount: Number(billedAmount), claimType,
            referenceClaimId: claimType !== "NEW" ? referenceClaimId : null,
            issueDescription, additionalNotes,
          };
          const adj = runAutoAdjudication(submission, p);
          const fullSub = {
            ...submission,
            status: adj.finalStatus,
            autoNote: adj.autoNote,
            aiConfidence: adj.confidence,
            adjScore: adj.score,
            criteria: adj.criteria,
            criticalFail: adj.criticalFail,
            regulatory_basis: adj.regulatory_basis,
            allowed_amount: adj.allowed_amount,
            ncciFlag: adj.ncciFlag,
            fraudScore: adj.fraudScore,
            passedCount: adj.passedCount,
            totalCount: adj.totalCount,
            timestamp: new Date().toISOString(),
          };
          setAdjSteps([
            {text:"CPT–ICD-10 alignment checked",done:true},
            {text:"Fraud & risk analysis complete",done:true},
            {text:"Authorization, amount & policy checks complete",done:true},
            {text:`Decision: ${adj.finalStatus} (score ${adj.score}/100) — sealing to blockchain…`,done:true},
          ]);
          setTimeout(()=>{
            const result = onSubmitClaim(fullSub);
            setSubmitted({...fullSub, ...result, adj});
            setSubmitting(false);
            setIssueDescription(""); setAdditionalNotes("");
          }, 300);
        }, 450);
      }, 350);
    }, 300);
  }

  if (submitted) {
    const s = submitted;
    const isApproved = s.status === "APPROVED";
    const isDenied   = s.status === "DENIED";
    const isReview   = s.status === "NEEDS_REVIEW";
    const statusColor = isApproved ? "var(--gr)" : isDenied ? "var(--re)" : "var(--am)";
    const statusIcon  = isApproved ? "✅" : isDenied ? "❌" : "⚠️";
    return (
      <div className="success-flash" style={{borderColor: isApproved?"rgba(16,185,129,0.3)":isDenied?"rgba(239,68,68,0.3)":"rgba(245,158,11,0.3)"}}>
        {/* Decision header */}
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:11}}>
          <span style={{fontSize:"1.5rem"}}>{statusIcon}</span>
          <div style={{flex:1}}>
            <div style={{fontFamily:"var(--fh)",fontSize:"0.95rem",fontWeight:800,color:statusColor}}>
              Claim {isApproved?"APPROVED":isDenied?"DENIED":"UNDER REVIEW"}
            </div>
            <div style={{fontSize:"0.65rem",color:"var(--mu)",marginTop:1}}>
              {isApproved ? `Your ${s.claimType==="APPEAL"?"appeal":"claim"} has been automatically approved.` :
               isDenied   ? `Your ${s.claimType==="APPEAL"?"appeal":"claim"} did not meet required criteria.` :
               "Your claim requires manual review. You'll be notified within 3–5 business days."}
            </div>
          </div>
          <span className={`rd ${isApproved?"approved":isDenied?"denied":"review"}`} style={{fontSize:"0.7rem"}}>{s.adjScore}/100</span>
        </div>

        {/* Allowed amount if approved */}
        {isApproved && s.allowed_amount > 0 && (
          <div style={{background:"rgba(16,185,129,0.07)",border:"1px solid rgba(16,185,129,0.2)",borderRadius:7,padding:"8px 12px",marginBottom:10,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <span style={{fontSize:"0.69rem",color:"var(--mu)"}}>Approved Amount</span>
            <span style={{fontFamily:"var(--fh)",fontSize:"1.05rem",color:"var(--gr)",fontWeight:800}}>${s.allowed_amount.toLocaleString()}</span>
          </div>
        )}

        {/* Criteria breakdown */}
        <div style={{marginBottom:9}}>
          <div style={{fontSize:"0.6rem",color:"var(--mu)",textTransform:"uppercase",letterSpacing:"0.7px",marginBottom:6}}>
            Adjudication Criteria — {s.passedCount}/{s.totalCount} passed
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:3}}>
            {(s.criteria||[]).map((c,i)=>(
              <div key={i} style={{display:"flex",gap:7,alignItems:"flex-start",padding:"4px 7px",background:c.passed?"rgba(16,185,129,0.04)":"rgba(239,68,68,0.04)",borderRadius:5,border:`1px solid ${c.passed?"rgba(16,185,129,0.12)":c.critical?"rgba(239,68,68,0.25)":"rgba(239,68,68,0.1)"}`}}>
                <span style={{fontSize:"0.72rem",flexShrink:0,marginTop:1}}>{c.passed?"✓":"✗"}</span>
                <div style={{flex:1}}>
                  <div style={{fontSize:"0.67rem",fontWeight:600,color:c.passed?"var(--gr)":c.critical?"var(--re)":"var(--am)"}}>
                    {c.label}{c.critical&&!c.passed&&" ⚡ CRITICAL"}
                  </div>
                  <div style={{fontSize:"0.62rem",color:"var(--mu)",marginTop:1,lineHeight:1.45}}>{c.detail}</div>
                </div>
                <span style={{fontSize:"0.58rem",color:"var(--di)",flexShrink:0,marginTop:1}}>w:{c.weight}</span>
              </div>
            ))}
          </div>
        </div>

        {/* AI decision note */}
        <div style={{background:"rgba(0,204,255,0.04)",border:"1px solid rgba(0,204,255,0.12)",borderRadius:7,padding:"7px 10px",marginBottom:7}}>
          <div style={{fontSize:"0.59rem",color:"var(--ac)",textTransform:"uppercase",marginBottom:2}}>Auto-Adjudication Note · Confidence {s.aiConfidence}%</div>
          <div style={{fontSize:"0.69rem",color:"#6a9fbe",lineHeight:1.6}}>{s.autoNote}</div>
        </div>

        <div style={{fontSize:"0.63rem",color:"var(--di)",marginBottom:10}}>📜 {s.regulatory_basis}</div>
        <div style={{fontFamily:"var(--fm)",fontSize:"0.59rem",color:"var(--a2)",marginBottom:11}}>HASH: {s.hash} · Block #{s.blockIndex}</div>

        <div style={{display:"flex",gap:7}}>
          <button className="btns" onClick={()=>{setSubmitted(null);setAdjSteps([]);}}>← File Another</button>
          {isDenied && <button className="btnr" onClick={()=>{setSubmitted(null);setClaimType("APPEAL");setAdjSteps([]);}}>⚖ Appeal This Decision</button>}
        </div>
      </div>
    );
  }

  return (
    <div className="appeal-form">
      <div style={{display:"flex",gap:5,marginBottom:13}}>
        {[{id:"NEW",l:"🆕 New Claim"},{id:"APPEAL",l:"⚖ Appeal Denial"},{id:"RESEND",l:"🔄 Re-submit & Correct"}].map(t=>(
          <button key={t.id} className="btns" style={{flex:1,justifyContent:"center",padding:"6px 8px",fontSize:"0.71rem",background:claimType===t.id?"rgba(0,204,255,0.08)":"transparent",color:claimType===t.id?"var(--ac)":"var(--mu)",borderColor:claimType===t.id?"rgba(0,204,255,0.3)":"var(--bd)"}} onClick={()=>setClaimType(t.id)}>{t.l}</button>
        ))}
      </div>

      {claimType === "NEW" && (
        <div style={{background:"rgba(0,204,255,0.04)",border:"1px solid rgba(0,204,255,0.12)",borderRadius:7,padding:"8px 10px",marginBottom:10,fontSize:"0.69rem",color:"var(--mu)",lineHeight:1.55}}>
          Filing a new insurance claim for a condition or procedure not previously submitted. All fields are required. Your claim will be routed to {p.insurer} within 1 business day.
        </div>
      )}
      {claimType === "APPEAL" && (
        <div style={{background:"rgba(249,115,22,0.05)",border:"1px solid rgba(249,115,22,0.18)",borderRadius:7,padding:"8px 10px",marginBottom:10,fontSize:"0.69rem",color:"var(--am)",lineHeight:1.55}}>
          ⚖ Appealing a denied claim. Per ACA §1557 and your policy rights, you have 30–60 days from denial to file a Level 1 appeal. Include as much supporting documentation as possible.
        </div>
      )}
      {claimType === "RESEND" && (
        <div style={{background:"rgba(139,92,246,0.05)",border:"1px solid rgba(139,92,246,0.18)",borderRadius:7,padding:"8px 10px",marginBottom:10,fontSize:"0.69rem",color:"#a78bfa",lineHeight:1.55}}>
          🔄 Correcting and re-submitting a previously rejected or errored claim. Describe what changed or what documentation you are adding.
        </div>
      )}

      <div className="g2" style={{gap:8}}>
        <div className="aff">
          <label>CPT Code</label>
          <select value={cptCode} onChange={e=>setCptCode(e.target.value)}>
            {CPT_LIST.map(c=><option key={c.code} value={c.code}>{c.code} — {c.name}</option>)}
          </select>
        </div>
        <div className="aff">
          <label>Billed Amount ($)</label>
          <input type="number" value={billedAmount} onChange={e=>setBilledAmount(e.target.value)} placeholder="e.g. 1200"/>
        </div>
      </div>

      {claimType !== "NEW" && (
        <div className="aff">
          <label>Reference Claim ID {deniedClaims.length > 0 && "(select denied claim)"}</label>
          <select value={referenceClaimId} onChange={e=>setReferenceClaimId(e.target.value)}>
            <option value="">— Select or type manually —</option>
            {deniedClaims.map(c=><option key={c.claimId} value={c.claimId}>{c.claimId} · {c.date} · ${c.amount} · DENIED</option>)}
            {p.claimHistory.filter(c=>c.status==="PENDING"||c.status==="NEEDS_REVIEW").map(c=><option key={c.claimId} value={c.claimId}>{c.claimId} · {c.status}</option>)}
          </select>
        </div>
      )}

      <div className="aff">
        <label>{claimType==="NEW"?"Issue / Condition Description *":claimType==="APPEAL"?"Reason for Appeal *":"Correction Details *"}</label>
        <textarea
          value={issueDescription}
          onChange={e=>setIssueDescription(e.target.value)}
          placeholder={
            claimType==="NEW" ? "Describe the health issue, symptoms, and why this procedure is necessary…" :
            claimType==="APPEAL" ? "Explain why you believe the denial was incorrect. Reference specific symptoms, dates, and treatment history…" :
            "Describe what was incorrect in the original submission and what has been corrected…"
          }
          rows={3}
        />
      </div>

      <div className="aff">
        <label>Supporting Documentation / Additional Notes</label>
        <textarea
          value={additionalNotes}
          onChange={e=>setAdditionalNotes(e.target.value)}
          placeholder="Physician letter, test results, prior treatment history, referral details, prescription records…"
          rows={2}
        />
      </div>

      <div style={{display:"flex",justifyContent:"flex-end",gap:8,marginTop:4}}>
        <button className="btn btnp" onClick={submit} disabled={submitting||!issueDescription.trim()} style={{fontSize:"0.79rem"}}>
          {submitting?"⏳ Adjudicating…":claimType==="NEW"?"📬 File & Auto-Adjudicate":claimType==="APPEAL"?"⚖ Submit Appeal":"🔄 Re-submit Claim"}
        </button>
      </div>
      {adjSteps.length > 0 && <Steps steps={adjSteps}/>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// PATIENT PORTAL  (updated)
// ═══════════════════════════════════════════════════════
function PatientPortal({ p, auditLog, patientClaims, onSubmitClaim }) {
  const [portalTab, setPortalTab] = useState("health");
  const [activeAppealId, setActiveAppealId] = useState(null);
  const myBlocks = auditLog.filter(b=>b.patientId===p.id);
  const mySubmissions = patientClaims.filter(c=>c.patientId===p.id);
  const pendingSubmissions = mySubmissions.filter(c=>c.status==="PENDING"||c.status==="QUEUED");
  const initials = p.name.split(" ").map(n=>n[0]).join("");
  const authColor = p.authStatus==="APPROVED"?"var(--gr)":p.authStatus==="DENIED"?"var(--re)":"var(--am)";
  const claimColor = p.claimStatus==="PAID"||p.claimStatus==="APPROVED"?"var(--gr)":p.claimStatus==="DENIED"?"var(--re)":"var(--am)";
  const rc = p.riskScore>70?"var(--re)":p.riskScore>40?"var(--am)":"var(--gr)";

  const decisionStatusClass = s => {
    if (s==="APPROVED"||s==="APPEAL_ACCEPTED"||s==="RESEND_PROCESSED") return "tg";
    if (s==="DENIED") return "tr";
    if (s==="MORE_INFO_NEEDED") return "tp";
    return "ta";
  };

  return (
    <div>
      {/* Hero */}
      <div className="portal-hero">
        <div style={{display:"flex",alignItems:"center",gap:13}}>
          <div style={{width:50,height:50,borderRadius:11,background:"linear-gradient(135deg,var(--a2),var(--ac))",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"var(--fh)",fontSize:"1.1rem",color:"#fff",flexShrink:0}}>{initials}</div>
          <div>
            <div style={{fontFamily:"var(--fh)",fontSize:"1.05rem"}}>{p.name}</div>
            <div style={{fontSize:"0.67rem",color:"var(--mu)",marginTop:2}}>{p.id} · {p.insurer} · {p.age}y {p.gender}</div>
            <div style={{display:"flex",gap:5,marginTop:7,flexWrap:"wrap"}}>
              <span className="tag tb">{p.bloodGroup}</span>
              <span className="tag ta">{p.primaryDiagnosis.name}</span>
              <span className="tag tb">{p.occupation}</span>
              {pendingSubmissions.length>0&&<span className="tag tor">📬 {pendingSubmissions.length} submission{pendingSubmissions.length>1?"s":""} pending</span>}
            </div>
          </div>
        </div>
        <div style={{display:"flex",gap:9,marginTop:15,flexWrap:"wrap"}}>
          {[["Prior Auth",p.authStatus,authColor],["Claim Status",p.claimStatus,claimColor],["Risk Score",`${p.riskScore}/100`,rc],["My Filings",mySubmissions.length,"var(--a2)"]].map(([l,v,c])=>(
            <div key={l} style={{background:"rgba(255,255,255,0.03)",border:"1px solid var(--bd)",borderRadius:9,padding:"9px 13px",flex:1,minWidth:100}}>
              <div style={{fontSize:"0.61rem",color:"var(--mu)",marginBottom:3}}>{l}</div>
              <div style={{fontFamily:"var(--fh)",fontSize:"0.92rem",fontWeight:800,color:c}}>{v}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Portal Tabs */}
      <div className="portal-tabs">
        <div className={`ptab ${portalTab==="health"?"active":""}`} onClick={()=>setPortalTab("health")}>🏥 Health Record</div>
        <div className={`ptab ${portalTab==="claims"?"active":""}`} onClick={()=>setPortalTab("claims")}>
          📋 Claims & History
          {mySubmissions.length>0&&<span style={{marginLeft:5,fontSize:"0.58rem",background:"rgba(249,115,22,0.15)",color:"var(--or)",padding:"0 5px",borderRadius:8}}>{mySubmissions.length}</span>}
        </div>
        <div className={`ptab ${portalTab==="file"?"active":""}`} onClick={()=>setPortalTab("file")}>📬 File / Appeal</div>
      </div>

      {/* Health Record Tab */}
      {portalTab === "health" && (
        <>
          <div className="g2">
            <div className="card">
              <div className="ct">My Insurance</div>
              <div className="kv2">
                {[["Insurer",p.insurer],["Policy No",p.policyNo],["Member ID",p.memberId],["Group ID",p.groupId],["Deductible",`$${p.deductible}`],["Ded. Met",`$${p.deductibleMet}`],["Copay",`$${p.copay}`],["Billed",`$${p.billedAmount.toFixed(0)}`]].map(([k,v])=>(
                  <div className="kv" key={k}><div className="kvk">{k}</div><div className="kvv">{v}</div></div>
                ))}
              </div>
            </div>
            <div className="card">
              <div className="ct">My Diagnosis</div>
              <div className="kv2">
                {[["ICD-10",p.primaryDiagnosis.icd10],["Condition",p.primaryDiagnosis.name],["Category",p.primaryDiagnosis.category],["Severity",p.diagnosisSeverity],["Since",p.diagnosisDate],["Comorbidities",p.disease.comorbidities.join(", ")],["Medications",p.medications.join(", ")],["Allergies",p.allergies.join(", ")]].map(([k,v])=>(
                  <div className="kv" key={k}><div className="kvk">{k}</div><div className="kvv">{v}</div></div>
                ))}
              </div>
            </div>
          </div>
          <div className="card">
            <div className="ct">My Vitals <span className="ctb">Last Visit: {p.lastVisit}</span></div>
            <div className="vitrow">{Object.entries(p.vitals).map(([l,v])=><div className="vitpill" key={l}><div className="vitl">{l}</div><div className="vitv">{v}</div></div>)}</div>
          </div>
          <div className="card">
            <div className="ct">My Requested Procedure</div>
            <div className="g2">
              {[["CPT Code",p.requestedProcedure.code],["Procedure",p.requestedProcedure.name],["Category",p.requestedProcedure.category],["Scheduled",p.procedureDate||"TBD"]].map(([k,v])=>(
                <div className="kv" key={k}><div className="kvk">{k}</div><div className="kvv">{v}</div></div>
              ))}
            </div>
            <div style={{marginTop:11,padding:"9px 13px",background:"rgba(0,204,255,0.04)",border:"1px solid rgba(0,204,255,0.14)",borderRadius:8}}>
              <div style={{fontSize:"0.67rem",color:"var(--mu)",marginBottom:3}}>Auth Required</div>
              <div style={{fontFamily:"var(--fh)",fontSize:"0.88rem",color:p.requestedProcedure.requiresAuth?"var(--am)":"var(--gr)"}}>{p.requestedProcedure.requiresAuth?"Yes — Authorization needed":"No — Direct access"}</div>
            </div>
          </div>
          {myBlocks.length>0&&(
            <div className="card">
              <div className="ct">My AI Decisions <span className="ctb">{myBlocks.length} blocks</span></div>
              {myBlocks.map((b,i)=>(
                <div key={i} style={{padding:"7px 0",borderBottom:"1px solid var(--bd)"}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3}}>
                    <span className={`rd ${b.decision==="APPROVED"?"approved":b.decision==="DENIED"?"denied":"review"}`} style={{fontSize:"0.61rem",padding:"1px 7px"}}>{b.decision||b.type}</span>
                    <span style={{fontSize:"0.63rem",color:"var(--mu)"}}>{new Date(b.timestamp).toLocaleTimeString()}</span>
                  </div>
                  <span style={{fontFamily:"var(--fm)",fontSize:"0.57rem",color:"var(--a2)"}}>HASH: {b.hash}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Claims & History Tab */}
      {portalTab === "claims" && (
        <>
          <div className="card">
            <div className="ct">My Claim History</div>
            {p.claimHistory.map((c,i)=>(
              <div key={i} style={{borderBottom:"1px solid var(--bd)",paddingBottom:10,marginBottom:10}}>
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <div style={{flex:1}}>
                    <div style={{fontSize:"0.76rem",fontWeight:600}}>{c.claimId}</div>
                    <div style={{fontSize:"0.63rem",color:"var(--mu)",marginTop:2}}>{c.date} · CPT {c.cpt}</div>
                  </div>
                  <div style={{fontFamily:"var(--fm)",fontSize:"0.78rem"}}>${c.amount.toLocaleString()}</div>
                  <span className={`tag ${c.status==="APPROVED"||c.status==="PAID"?"tg":c.status==="DENIED"?"tr":"ta"}`}>{c.status}</span>
                </div>
                {c.denialReason && (
                  <div className="denial-badge">
                    <span>⚠</span>
                    <div>
                      <div style={{fontWeight:600,marginBottom:2}}>Denial Reason: {c.denialReason}</div>
                      <div style={{fontSize:"0.62rem",opacity:0.8}}>You can appeal this decision or re-submit with corrections.</div>
                    </div>
                  </div>
                )}
                {(c.status === "DENIED" || c.status === "PENDING" || c.status === "NEEDS_REVIEW") && (
                  <div className="claim-action-row">
                    {c.status === "DENIED" && (
                      <button className="btnr" onClick={()=>{ setActiveAppealId(c.claimId); setPortalTab("file"); }}>
                        ⚖ Appeal This Denial
                      </button>
                    )}
                    <button className="btns" onClick={()=>{ setActiveAppealId(c.claimId); setPortalTab("file"); }}>
                      🔄 Re-submit / Correct
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>

          {mySubmissions.length > 0 && (
            <div className="card">
              <div className="ct">My Filed Submissions <span className="ctb">{mySubmissions.length} total</span></div>
              {[...mySubmissions].reverse().map((s,i)=>(
                <div key={i} style={{padding:"9px 0",borderBottom:"1px solid var(--bd)"}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4,flexWrap:"wrap"}}>
                    <span className={`tag ${s.claimType==="APPEAL"?"tor":s.claimType==="RESEND"?"tp":"tb"}`} style={{fontSize:"0.59rem"}}>{s.claimType==="NEW"?"New Claim":s.claimType==="APPEAL"?"Appeal":"Re-submit"}</span>
                    <span className={`tag ${decisionStatusClass(s.status)}`} style={{fontSize:"0.59rem"}}>{s.status}</span>
                    <span style={{fontFamily:"var(--fm)",fontSize:"0.62rem",color:"var(--ac)"}}>{s.cptCode}</span>
                    <span style={{marginLeft:"auto",fontSize:"0.6rem",color:"var(--di)"}}>{new Date(s.timestamp).toLocaleString()}</span>
                  </div>
                  {s.adminNote && (
                    <div style={{fontSize:"0.69rem",color:"var(--gr)",background:"rgba(16,185,129,0.05)",border:"1px solid rgba(16,185,129,0.12)",borderRadius:6,padding:"5px 8px",marginTop:4}}>
                      <span style={{opacity:0.6,fontSize:"0.58rem",textTransform:"uppercase",marginRight:4}}>Admin:</span>{s.adminNote}
                    </div>
                  )}
                  {s.status==="MORE_INFO_NEEDED" && (
                    <div style={{fontSize:"0.69rem",color:"var(--am)",marginTop:4}}>
                      ⚠ Additional information requested. Please re-submit with more documentation.
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* File / Appeal Tab */}
      {portalTab === "file" && (
        <div className="appeal-banner">
          <div style={{display:"flex",alignItems:"center",gap:9,marginBottom:3}}>
            <span style={{fontSize:"1.1rem"}}>📬</span>
            <div>
              <div style={{fontFamily:"var(--fh)",fontSize:"0.85rem",color:"var(--tx)"}}>File a New Claim, Appeal, or Re-Submission</div>
              <div style={{fontSize:"0.67rem",color:"var(--mu)",marginTop:2}}>Submissions are blockchain-sealed and routed to your insurer ({p.insurer}) in real-time. Admin is notified instantly.</div>
            </div>
          </div>
          <PatientClaimForm
            p={p}
            onSubmitClaim={onSubmitClaim}
            initialType={activeAppealId ? "APPEAL" : "NEW"}
            initialRefId={activeAppealId}
          />
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// APP  (updated — shared patientClaims state)
// ═══════════════════════════════════════════════════════
const ADMIN_NAV=[
  {sec:"Overview"},{id:"dashboard",ic:"⬡",l:"Command Center"},
  {sec:"AI Agents"},{id:"auth",ic:"🔐",l:"Prior Auth Agent"},{id:"claims",ic:"📋",l:"Claims Adjudication"},{id:"simulator",ic:"🧪",l:"Policy Simulator"},
  {sec:"Data"},{id:"db",ic:"🗄",l:"Database Viewer"},{id:"audit",ic:"⛓",l:"Audit Trail"},
  {sec:"Patient Ops"},{id:"patientclaims",ic:"📬",l:"Patient Claims Queue"},
];
const META={
  dashboard:{t:"Command Center",s:"Real-time clinical operations intelligence"},
  auth:{t:"Prior Authorization Agent",s:"Agentic context selection → AI reasoning → Blockchain seal"},
  claims:{t:"Claims Adjudication Engine",s:"NCCI bundling · fraud scoring · instant decision"},
  simulator:{t:"Policy Impact Simulator",s:"Model downstream effects of payer rule changes"},
  db:{t:"Database Viewer",s:"15 synthetic patient records — all profiles"},
  audit:{t:"Blockchain Audit Trail",s:"Immutable hash-chained log of every decision"},
  patientclaims:{t:"Patient Claims Queue",s:"Real-time appeals, new claims & re-submissions from patients"},
};

export default function App() {
  const [session, setSession] = useState(null);
  const [page, setPage] = useState("dashboard");
  const [auditLog, setAuditLog] = useState([]);
  const [patientClaims, setPatientClaims] = useState([]);
  // Unseen: IDs of claims submitted since admin last visited the queue
  const [unseenIds, setUnseenIds] = useState(new Set());

  function onLogin(user) { setSession(user); setPage(user.role==="admin"?"dashboard":"portal"); }
  function onLogout() { setSession(null); setPage("dashboard"); setUnseenIds(new Set()); }
  function seal(block) { setAuditLog(p=>[...p,block]); }

  function addPatientClaim(submission) {
    const block = sealToChain({ type:"PATIENT_CLAIM", ...submission });
    const newEntry = {
      ...submission,
      id: `PCL-${Date.now()}`,
      hash: block.hash,
      blockIndex: block.blockIndex,
    };
    setPatientClaims(prev => [...prev, newEntry]);
    setAuditLog(prev => [...prev, block]);
    // Mark unseen for admin — covers ALL auto-decisions (approved, denied, review)
    setUnseenIds(prev => new Set([...prev, newEntry.id]));
    return { hash: block.hash, blockIndex: block.blockIndex };
  }

  function resolvePatientClaim(claimId, newStatus, adminNote) {
    setPatientClaims(prev => prev.map(c =>
      c.id === claimId
        ? { ...c, status: newStatus, adminNote: adminNote||"", resolvedAt: new Date().toISOString() }
        : c
    ));
    const block = sealToChain({ type:"CLAIM_RESOLUTION", claimId, status: newStatus, adminNote });
    setAuditLog(prev => [...prev, block]);
  }

  function markAllSeen() { setUnseenIds(new Set()); }

  const unseenCount    = unseenIds.size;
  const unseenClaims   = patientClaims.filter(c => unseenIds.has(c.id));
  const unseenApproved = unseenClaims.filter(c => c.status==="APPROVED").length;
  const unseenDenied   = unseenClaims.filter(c => c.status==="DENIED").length;
  const unseenReview   = unseenClaims.filter(c => c.status==="NEEDS_REVIEW").length;
  const pendingPatientClaims = patientClaims.filter(c=>c.status==="NEEDS_REVIEW").length;

  if (!session) return <><style>{css}</style><LoginScreen onLogin={onLogin}/></>;

  if (session.role === "patient") {
    const pd = DB_PATIENTS.find(p=>p.id===session.patientId);
    const initials = pd?.name.split(" ").map(n=>n[0]).join("")||"P";
    const mySubmissions = patientClaims.filter(c=>c.patientId===pd?.id);
    return (
      <>
        <style>{css}</style>
        <div className="app">
          <aside className="sidebar">
            <div className="logo"><h1>ClearPath AI</h1><p>Patient Portal</p></div>
            <nav className="nav">
              <div className="ns">My Account</div>
              <div className="ni active"><span className="ic">🏥</span><span>My Health Record</span></div>
            </nav>
            <div className="sf2">
              <div className="uchip">
                <div className="uav">{initials}</div>
                <div>
                  <div className="uname">{pd?.name}</div>
                  <div className="urole">Patient · {pd?.insurer}</div>
                </div>
              </div>
              {mySubmissions.length > 0 && (
                <div style={{marginBottom:8,background:"rgba(249,115,22,0.07)",border:"1px solid rgba(249,115,22,0.2)",borderRadius:7,padding:"5px 9px",fontSize:"0.67rem",color:"var(--or)"}}>
                  📬 {mySubmissions.length} filing{mySubmissions.length>1?"s":""} on record
                </div>
              )}
              <button className="btnlo" onClick={onLogout}>← Sign Out</button>
            </div>
          </aside>
          <main className="main">
            <div className="topbar">
              <div>
                <div style={{fontFamily:"var(--fh)",fontSize:"0.98rem",fontWeight:700}}>My Health Portal</div>
                <div style={{fontSize:"0.68rem",color:"var(--mu)",marginTop:2}}>Health record · Claims · Appeals · New filings</div>
              </div>
              <RtBadge/>
            </div>
            <div className="content">
              {pd
                ? <PatientPortal p={pd} auditLog={auditLog} patientClaims={patientClaims} onSubmitClaim={addPatientClaim}/>
                : <div style={{color:"var(--mu)"}}>Record not found.</div>
              }
            </div>
          </main>
        </div>
      </>
    );
  }

  const m = META[page];

  // Navigate to queue AND clear unseen badge
  function goToQueue() { setPage("patientclaims"); markAllSeen(); }

  return (
    <>
      <style>{css}</style>
      <div className="app">
        <aside className="sidebar">
          <div className="logo"><h1>ClearPath AI</h1><p>Admin · Revenue Cycle</p></div>
          <nav className="nav">
            {ADMIN_NAV.map((n,i)=>n.sec?(
              <div className="ns" key={`s${i}`}>{n.sec}</div>
            ):(
              <div key={n.id} className={`ni ${page===n.id?"active":""}`}
                onClick={()=>{ if(n.id==="patientclaims") goToQueue(); else setPage(n.id); }}>
                <span className="ic">{n.ic}</span><span>{n.l}</span>
                {n.id==="audit"&&auditLog.length>0&&<span className="bdg">{auditLog.length}</span>}
                {n.id==="db"&&<span className="bdg">{DB_PATIENTS.length}</span>}
                {/* Show unseen count (all decisions) not just NEEDS_REVIEW */}
                {n.id==="patientclaims"&&unseenCount>0&&<span className="bdg-alert">{unseenCount}</span>}
              </div>
            ))}
          </nav>
          <div className="sf2">
            <div className="uchip"><div className="uav">A</div><div><div className="uname">Admin</div><div className="urole">Administrator</div></div></div>
            {unseenCount > 0 && (
              <div style={{marginBottom:7,display:"flex",flexDirection:"column",gap:3,background:"rgba(0,0,0,0.2)",border:"1px solid var(--bd)",borderRadius:7,padding:"7px 9px",cursor:"pointer"}} onClick={goToQueue}>
                <div style={{fontSize:"0.6rem",color:"var(--mu)",textTransform:"uppercase",letterSpacing:"0.6px",marginBottom:2}}>New patient claims ↓</div>
                {unseenApproved>0&&<div style={{display:"flex",alignItems:"center",gap:5,fontSize:"0.68rem",color:"var(--gr)",fontWeight:600}}><div style={{width:5,height:5,borderRadius:"50%",background:"var(--gr)"}}/>✓ {unseenApproved} Auto-Approved</div>}
                {unseenDenied>0&&<div style={{display:"flex",alignItems:"center",gap:5,fontSize:"0.68rem",color:"var(--re)",fontWeight:600}}><div style={{width:5,height:5,borderRadius:"50%",background:"var(--re)"}}/>✗ {unseenDenied} Auto-Denied</div>}
                {unseenReview>0&&<div style={{display:"flex",alignItems:"center",gap:5,fontSize:"0.68rem",color:"var(--am)",fontWeight:600}}><div style={{width:5,height:5,borderRadius:"50%",background:"var(--am)",animation:"pulse 1.5s infinite"}}/>⚠ {unseenReview} Need Review</div>}
              </div>
            )}
            <button className="btnlo" onClick={onLogout}>← Sign Out</button>
          </div>
        </aside>
        <main className="main">
          {/* Live notification banner — shown on ALL pages whenever there are unseen claims */}
          {unseenCount > 0 && (
            <div className="notif-banner">
              <span style={{fontSize:"0.68rem",color:"var(--mu)",marginRight:2}}>🔔 New patient claims:</span>
              {unseenApproved>0&&(
                <div className="notif-item notif-approved" onClick={goToQueue}>
                  <div className="notif-dot" style={{background:"var(--gr)"}}/>
                  ✓ {unseenApproved} Auto-Approved
                </div>
              )}
              {unseenDenied>0&&(
                <div className="notif-item notif-denied" onClick={goToQueue}>
                  <div className="notif-dot" style={{background:"var(--re)"}}/>
                  ✗ {unseenDenied} Auto-Denied
                </div>
              )}
              {unseenReview>0&&(
                <div className="notif-item notif-review" onClick={goToQueue}>
                  <div className="notif-dot" style={{background:"var(--am)"}}/>
                  ⚠ {unseenReview} Need Review
                </div>
              )}
              <button className="btns" style={{marginLeft:"auto",padding:"3px 9px",fontSize:"0.67rem"}} onClick={goToQueue}>
                View All →
              </button>
              <button style={{background:"transparent",border:"none",color:"var(--mu)",cursor:"pointer",fontSize:"0.75rem",padding:"0 4px"}} onClick={markAllSeen} title="Dismiss">✕</button>
            </div>
          )}
          <div className="topbar">
            <div>
              <div style={{fontFamily:"var(--fh)",fontSize:"0.98rem",fontWeight:700}}>{m.t}</div>
              <div style={{fontSize:"0.68rem",color:"var(--mu)",marginTop:2}}>{m.s}</div>
            </div>
            <RtBadge/>
          </div>
          <div className="content">
            {page==="dashboard"     && <AdminDashboard auditLog={auditLog} patientClaims={patientClaims} onGoToQueue={goToQueue}/>}
            {page==="auth"          && <AdminAuth onSeal={seal}/>}
            {page==="claims"        && <AdminClaims onSeal={seal}/>}
            {page==="simulator"     && <AdminSim onSeal={seal}/>}
            {page==="db"            && <AdminDB/>}
            {page==="audit"         && <AdminAudit log={auditLog}/>}
            {page==="patientclaims" && <AdminPatientClaims patientClaims={patientClaims} onResolve={resolvePatientClaim} onMount={markAllSeen}/>}
          </div>
        </main>
      </div>
    </>
  );
}
