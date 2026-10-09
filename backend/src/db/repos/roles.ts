import type { Permission, Role } from '../../domain/index.js';
import type { Db } from '../client.js';

interface RoleRow {
  id: string;
  company_id: string | null;
  name: string;
  description: string | null;
  created_at: Date;
  updated_at: Date;
  [k: string]: unknown;
}
interface PermissionRow {
  id: string;
  code: string;
  description: string | null;
  created_at: Date;
  [k: string]: unknown;
}

const toRole = (r: RoleRow): Role => ({
  id: r.id,
  companyId: r.company_id,
  name: r.name,
  description: r.description,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const toPermission = (r: PermissionRow): Permission => ({
  id: r.id,
  code: r.code,
  description: r.description,
  createdAt: r.created_at,
});

export class RoleRepository {
  constructor(private readonly db: Db) {}

  async getUserRoles(userId: string): Promise<Role[]> {
    const rows = await this.db.query<RoleRow>(
      `SELECT r.id, r.company_id, r.name, r.description, r.created_at, r.updated_at
         FROM roles r JOIN user_roles ur ON ur.role_id = r.id
        WHERE ur.user_id = $1 ORDER BY r.name`,
      [userId],
    );
    return rows.map(toRole);
  }

  async getUserPermissions(userId: string): Promise<Permission[]> {
    const rows = await this.db.query<PermissionRow>(
      `SELECT DISTINCT p.id, p.code, p.description, p.created_at
         FROM permissions p
         JOIN role_permissions rp ON rp.permission_id = p.id
         JOIN user_roles ur ON ur.role_id = rp.role_id
        WHERE ur.user_id = $1 ORDER BY p.code`,
      [userId],
    );
    return rows.map(toPermission);
  }

  /** Sistem (company_id NULL) və ya verilmiş şirkətin rolu. */
  async findRoleByName(name: string, companyId: string | null = null): Promise<Role | null> {
    const [row] = await this.db.query<RoleRow>(
      `SELECT id, company_id, name, description, created_at, updated_at FROM roles
        WHERE name = $1 AND company_id IS NOT DISTINCT FROM $2`,
      [name, companyId],
    );
    return row ? toRole(row) : null;
  }

  async createRole(r: Role): Promise<Role> {
    await this.db.query(
      `INSERT INTO roles (id, company_id, name, description, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [r.id, r.companyId, r.name, r.description, r.createdAt, r.updatedAt],
    );
    return r;
  }

  async assignRoleToUser(userId: string, roleId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [userId, roleId],
    );
  }

  async grantPermissionToRole(roleId: string, permissionId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO role_permissions (role_id, permission_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [roleId, permissionId],
    );
  }

  async findPermissionByCode(code: string): Promise<Permission | null> {
    const [row] = await this.db.query<PermissionRow>(
      `SELECT id, code, description, created_at FROM permissions WHERE code = $1`,
      [code],
    );
    return row ? toPermission(row) : null;
  }
}
