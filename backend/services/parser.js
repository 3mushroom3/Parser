/**
 * РќРѕСЂРјР°Р»РёР·Р°С†РёСЏ РѕС‚РІРµС‚РѕРІ API Р¤Р“РРЎ в†’ СЃС‚СЂСѓРєС‚СѓСЂС‹ РїСЂРёР»РѕР¶РµРЅРёСЏ.
 * РџРѕР»СЏ РєР°СЂС‚РѕС‡РєРё: СЃРј. GET /api/v1/rds/common/declarations/{id}
 */

const EMPTY_DECL = {
  productGroup: '',
  manufacturer: {
    lastName: '',
    firstName: '',
    middleName: '',
    shortName: '',
    address: '',
    phone: '',
  },
  product: {
    batchSize: '',
    name: '',
    additionalInfo: '',
  },
};

function pickPhoneFromContacts(contacts) {
  if (!Array.isArray(contacts)) return '';
  const phones = contacts
    .map((c) => c?.value || c?.phone || '')
    .filter((v) => typeof v === 'string' && /\d/.test(v));
  return phones.join(', ');
}

function pickAddress(mfr, filials) {
  if (!mfr) return '';
  const a = Array.isArray(mfr.addresses) && mfr.addresses[0];
  if (a && (a.fullAddress || a.address)) return String(a.fullAddress || a.address).trim();
  if (Array.isArray(filials)) {
    for (const f of filials) {
      const fa = Array.isArray(f.addresses) && f.addresses[0];
      if (fa && (fa.fullAddress || fa.address)) return String(fa.fullAddress || fa.address).trim();
    }
  }
  return String(mfr.address || '').trim();
}

function pickProductionSites(mfr, filials) {
  const sites = [];
  const seen = new Set();
  const add = (v) => { const s = String(v).trim(); if (s && !seen.has(s)) { seen.add(s); sites.push(s); } };

  if (mfr) {
    if (Array.isArray(mfr.addresses)) {
      for (const a of mfr.addresses) {
        if (a.fullAddress || a.address) add(a.fullAddress || a.address);
      }
    } else if (mfr.address) {
      add(mfr.address);
    }
  }
  if (Array.isArray(filials)) {
    for (const f of filials) {
      if (Array.isArray(f.addresses)) {
        for (const a of f.addresses) {
          if (a.fullAddress || a.address) add(a.fullAddress || a.address);
        }
      } else if (f.address) {
        add(f.address);
      }
    }
  }
  return sites;
}

function pickInn(mfr) {
  if (!mfr) return '';
  return String(
    mfr.inn || mfr.orgInn || mfr.innCode || mfr.applicantInn || ''
  ).trim();
}

/** Р СѓРєРѕРІРѕРґРёС‚РµР»СЊ Р®Р›: РІ API С„Р°РјРёР»РёСЏ/РёРјСЏ/РѕС‚С‡РµСЃС‚РІРѕ РЅР° РѕР±СЉРµРєС‚Рµ Р·Р°СЏРІРёС‚РµР»СЏ/РёР·РіРѕС‚РѕРІРёС‚РµР»СЏ */
function pickHeadPerson(mfr) {
  if (!mfr) return { lastName: '', firstName: '', middleName: '' };
  return {
    lastName: String(mfr.surname || mfr.head?.lastName || mfr.headPerson?.lastName || '').trim(),
    firstName: String(mfr.firstName || mfr.head?.firstName || mfr.headPerson?.firstName || '').trim(),
    middleName: String(mfr.patronymic || mfr.middleName || mfr.head?.middleName || mfr.headPerson?.middleName || '').trim(),
  };
}

/**
 * Р“СЂСѓРїРїР° РїСЂРѕРґСѓРєС†РёРё Р•РђР­РЎ: РІ РѕС‚РєСЂС‹С‚РѕР№ РІС‹РґР°С‡Рµ РїСЂРёС…РѕРґРёС‚ РєР°Рє `group` РІ СЃС‚СЂРѕРєРµ СЃРїРёСЃРєР°.
 * Р’ РєР°СЂС‚РѕС‡РєРµ вЂ” С‚РѕР»СЊРєРѕ idGroups[]; Р±РµР· СЃС‚СЂРѕРєРё СЃРїРёСЃРєР° РґР°С‘Рј С‡РµР»РѕРІРµРєРѕС‡РёС‚Р°РµРјС‹Р№ fallback.
 */
function resolveProductGroup(detail, listItem) {
  if (listItem) {
    const g =
      listItem.group ||
      listItem.objKindVersion ||
      listItem.productGroup ||
      listItem.eaeuProductGroup ||
      '';
    if (g) return String(g).trim();
  }
  const ids = detail?.idGroups;
  if (Array.isArray(ids) && ids.length) return `Коды групп продукции ЕАЭС: ${ids.join(', ')}`;
  return '';
}

function pickManufacturerBlock(detail) {
  const mfr = detail?.manufacturer || detail?.applicant;
  if (!mfr) return { ...EMPTY_DECL.manufacturer };
  const head = pickHeadPerson(mfr);
  const filials = detail?.manufacturerFilials || detail?.applicantFilials;
  return {
    ...head,
    inn: pickInn(mfr),
    shortName: String(mfr.shortName || mfr.fullName || '').trim(),
    address: pickAddress(mfr, filials),
    productionSites: pickProductionSites(mfr, filials),
    phone: pickPhoneFromContacts(mfr.contacts),
  };
}

/** Р•СЃР»Рё РєР°СЂС‚РѕС‡РєР° РЅРµРґРѕСЃС‚СѓРїРЅР°, С‡Р°СЃС‚СЊ РїРѕР»РµР№ РјРѕР¶РЅРѕ РІР·СЏС‚СЊ РёР· СЃС‚СЂРѕРєРё СЂРµРµСЃС‚СЂР° */
function manufacturerFromListItem(listItem) {
  if (!listItem) return { ...EMPTY_DECL.manufacturer };
  const name = String(listItem.manufacterName || listItem.manufacturerName || listItem.applicantName || '').trim();
  const address = String(listItem.manufacturerAddress || listItem.applicantAddress || '').trim();
  return {
    lastName: '',
    firstName: '',
    middleName: '',
    shortName: name,
    address,
    phone: '',
  };
}

function productFromListItem(listItem) {
  if (!listItem) return { ...EMPTY_DECL.product };
  return {
    batchSize: String(listItem.batchSize ?? listItem.productBatchSize ?? '').trim(),
    name: String(
      listItem.prodName ||
      listItem.productName ||
      listItem.productFullName ||
      listItem.productIdentificationName ||
      ''
    ).trim(),
    additionalInfo: '',
  };
}

function pickProduct(detail) {
  const p = detail?.product || {};
  const id0 = Array.isArray(p.identifications) && p.identifications[0];
  const batchSize = p.batchSize ?? id0?.amount ?? '';
  const name = String(p.fullName || id0?.name || '').trim();
  const parts = [
    id0?.description,
    p.usageScope,
    p.storageCondition,
    p.usageCondition,
    p.marking,
  ].filter(Boolean);
  return {
    batchSize: batchSize === null || batchSize === undefined ? '' : String(batchSize),
    name,
    additionalInfo: parts.map(String).join(' ').trim(),
  };
}

/**
 * РЈРЅРёС„РёС†РёСЂРѕРІР°РЅРЅС‹Р№ РѕР±СЉРµРєС‚ РґР»СЏ UI / СЌРєСЃРїРѕСЂС‚Р° (Р·Р°РґР°С‡Р° РўР—).
 * @param {object} detail вЂ” С‚РµР»Рѕ GET вЂ¦/declarations/{id}
 * @param {object|null} listItem вЂ” РѕРїС†РёРѕРЅР°Р»СЊРЅРѕ СЃС‚СЂРѕРєР° РёР· POST вЂ¦/declarations/get (РїРѕР»Рµ group Рё С‚.Рґ.)
 */
function mapToGetDeclarationData(detail, listItem = null) {
  if (!detail || typeof detail !== 'object' || !detail.idDeclaration) {
    return {
      productGroup: resolveProductGroup(null, listItem),
      manufacturer: manufacturerFromListItem(listItem),
      product: productFromListItem(listItem),
    };
  }
  return {
    productGroup: resolveProductGroup(detail, listItem),
    manufacturer: pickManufacturerBlock(detail),
    product: pickProduct(detail),
  };
}

/** РЎРѕРІРјРµСЃС‚РёРјРѕСЃС‚СЊ СЃ РїСЂРµР¶РЅРµР№ С‚Р°Р±Р»РёС†РµР№ Р‘Р” РїСЂРёР»РѕР¶РµРЅРёСЏ */
function fmtDate(raw) {
  if (!raw) return '';
  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  if (typeof raw === 'number') return new Date(raw > 1e10 ? raw : raw * 1000).toISOString().slice(0, 10);
  try {
    return new Date(raw).toISOString().slice(0, 10);
  } catch (_) {
    return '';
  }
}

function mapStatus(raw) {
  if (!raw) return 'active';
  const s = (typeof raw === 'object' ? raw.name || raw.shortName || '' : String(raw)).toLowerCase();
  if (s.includes('РїСЂРёРѕСЃС‚Р°РЅ') || s.includes('suspend')) return 'suspended';
  if (s.includes('РїСЂРµРєСЂР°С‰') || s.includes('Р°РЅРЅСѓР»') || s.includes('expir')) return 'expired';
  return 'active';
}

function mapRecordForDb(listItem, detail, fsaBaseUrl) {
  const structured = mapToGetDeclarationData(detail || {}, listItem);
  const m = structured.manufacturer;
  const p = structured.product;
  const fsaId = String(listItem?.id || listItem?.declId || listItem?.declarationId || detail?.idDeclaration || '');
  const d = detail || {};
  return {
    id: fsaId,
    declNumber: String(listItem?.number || listItem?.declNumber || '').trim(),
    source: 'fsa',
    status: mapStatus(listItem?.status || listItem?.docStatus || listItem?.idStatus || d.status),
    group: structured.productGroup || listItem?.group || '',
    technicalReglament: String(listItem?.technicalReglaments || listItem?.technicalReglament || '').trim(),
    regDate: fmtDate(listItem?.declDate || listItem?.regDate || d.declRegDate),
    endDate: fmtDate(listItem?.declEndDate || listItem?.endDate || d.declEndDate),
    inn: m.inn || String(listItem?.inn || listItem?.orgInn || '').trim(),
    lastName: m.lastName,
    firstName: m.firstName,
    middleName: m.middleName,
    shortName: m.shortName,
    fullName: (detail?.manufacturer || detail?.applicant)?.fullName || '',
    applicantName: String(
      listItem?.applicantName ||
      detail?.applicant?.fullName ||
      detail?.applicant?.shortName ||
      ''
    ).trim(),
    address: m.address,
    productionSites: m.productionSites || [],
    phone: m.phone,
    farmerType: 'unknown',
    productName: p.name || listItem?.prodName || '',
    batchSize: p.batchSize || String(listItem?.batchSize ?? '').trim(),
    otherInfo: p.additionalInfo,
    fsaId,
    fsaUrl: fsaId ? `${fsaBaseUrl}/rds/declaration/view/${fsaId}` : '',
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = {
  mapToGetDeclarationData,
  mapRecordForDb,
  mapStatus,
  fmtDate,
  EMPTY_DECL,
};

