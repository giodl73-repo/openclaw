/**
 * Unit tests for the doctor `workspace.json` section parser +
 * resolver. Mirrors the shape of pinch's lint resolver and lkg's
 * lkg resolver — each substrate ships its own section locally.
 */
import { describe, expect, it } from 'vitest';
import {
  resolveDoctorOverrides,
  type WorkspaceDoctorConfig,
} from '../../../src/plugin-sdk/oc-doctor/workspace-config.js';

const ALL_CONTRIBS = [
  'starter-v0/agents/add-boundaries-stub',
  'starter-v0/user/add-preferences-stub',
  'jsonc-starter-v0/config/add-plugins-stub',
  'jsonc-starter-v0/config/redact-secret-literal',
  'lkg-starter-v0/lkg/scrub-sentinel-from-tracked',
  'policy-starter-v0/tools/migrate-sensitivity-syntax',
];

describe('resolveDoctorOverrides', () => {
  it('RDO-01 empty config + no flags → empty disabled set', () => {
    const r = resolveDoctorOverrides(undefined, {}, ALL_CONTRIBS);
    expect(r.size).toBe(0);
  });

  it('RDO-02 workspace.json `doctor.skip` exact id matches', () => {
    const cfg: WorkspaceDoctorConfig = {
      skip: ['starter-v0/agents/add-boundaries-stub'],
    };
    const r = resolveDoctorOverrides(cfg, {}, ALL_CONTRIBS);
    expect(r.has('starter-v0/agents/add-boundaries-stub')).toBe(true);
    expect(r.has('starter-v0/user/add-preferences-stub')).toBe(false);
  });

  it('RDO-03 workspace.json glob expands against registered ids', () => {
    const cfg: WorkspaceDoctorConfig = { skip: ['policy-starter-v0/*'] };
    const r = resolveDoctorOverrides(cfg, {}, ALL_CONTRIBS);
    expect(r.has('policy-starter-v0/tools/migrate-sensitivity-syntax')).toBe(true);
    expect(r.has('starter-v0/agents/add-boundaries-stub')).toBe(false);
  });

  it('RDO-04 CLI skip is additive on top of workspace skip', () => {
    const cfg: WorkspaceDoctorConfig = { skip: ['policy-starter-v0/*'] };
    const r = resolveDoctorOverrides(
      cfg,
      { skip: ['lkg-starter-v0/lkg/scrub-sentinel-from-tracked'] },
      ALL_CONTRIBS,
    );
    expect(r.has('policy-starter-v0/tools/migrate-sensitivity-syntax')).toBe(true);
    expect(r.has('lkg-starter-v0/lkg/scrub-sentinel-from-tracked')).toBe(true);
  });

  it('RDO-05 ignores empty / undefined section gracefully', () => {
    expect(resolveDoctorOverrides({}, {}, ALL_CONTRIBS).size).toBe(0);
    expect(
      resolveDoctorOverrides({ skip: [] }, { skip: [] }, ALL_CONTRIBS).size,
    ).toBe(0);
  });
});
