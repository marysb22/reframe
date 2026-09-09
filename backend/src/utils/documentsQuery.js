// The one joined SELECT every document-list endpoint needs to feed
// toDocument() fully (uploader name/role, shared group/supervisor name,
// approver name) -- was independently copy-pasted in profile.js and
// supervisor.js before this file existed. Centralized here so the
// Documents Section's several read paths (Trainee/ToT/Master Trainer) stay
// a single definition instead of drifting out of sync with each other.
const DOCUMENT_SELECT = `
  SELECT d.*,
         COALESCE(a.full_name, sup.full_name, st_up.full_name) AS uploaded_by_name,
         uc.role AS uploaded_by_role,
         sup.supervisor_type AS uploaded_by_supervisor_type,
         tg.name AS shared_group_name,
         shsup.full_name AS shared_supervisor_name,
         shsup.supervisor_type AS shared_supervisor_type,
         apsup.full_name AS approved_by_name
    FROM documents d
    JOIN user_credentials uc ON uc.id = d.uploaded_by
    LEFT JOIN admin_users a ON a.id = d.uploaded_by
    LEFT JOIN supervisors sup ON sup.id = d.uploaded_by
    LEFT JOIN students st_up ON st_up.id = d.uploaded_by
    LEFT JOIN trainer_groups tg ON tg.id = d.group_id
    LEFT JOIN supervisors shsup ON shsup.id = d.shared_with_supervisor_id
    LEFT JOIN supervisors apsup ON apsup.id = d.approved_by
`;

module.exports = { DOCUMENT_SELECT };
