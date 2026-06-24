import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import {
  Users,
  Plus,
  Loader2,
  KeyRound,
  Trash2,
  ShieldCheck,
  UserCheck,
  Copy,
  Check,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface PublicUser {
  id: string;
  email: string;
  role: "admin" | "member";
  mustChange: boolean;
  createdAt: number;
  lastLoginAt: number | null;
}

interface AuthMe {
  authEnabled: boolean;
  signedIn: boolean;
  email: string | null;
  role: "admin" | "member" | null;
  mustChange: boolean;
}

function fmtDate(ts: number | null): string {
  if (!ts) return "Never";
  return new Date(ts * 1000).toLocaleString();
}

function generatePassword(length = 14): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let out = "";
  const arr = new Uint32Array(length);
  crypto.getRandomValues(arr);
  for (let i = 0; i < length; i++) out += chars[arr[i] % chars.length];
  return out;
}

export default function AdminUsers() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: me } = useQuery<AuthMe>({ queryKey: ["/api/auth/me"] });
  const { data, isLoading } = useQuery<{ users: PublicUser[] }>({
    queryKey: ["/api/admin/users"],
    enabled: me?.role === "admin",
  });

  // Create dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState(generatePassword());
  const [newRole, setNewRole] = useState<"admin" | "member">("member");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [createdCredentials, setCreatedCredentials] = useState<{
    email: string;
    password: string;
  } | null>(null);
  const [copiedField, setCopiedField] = useState<"email" | "password" | "combo" | null>(null);

  function resetCreateDialog() {
    setNewEmail("");
    setNewPassword(generatePassword());
    setNewRole("member");
    setCreateError("");
    setCreatedCredentials(null);
    setCopiedField(null);
  }

  async function handleCreate() {
    setCreateError("");
    if (!newEmail.includes("@")) {
      setCreateError("Enter a valid email address.");
      return;
    }
    if (newPassword.length < 8) {
      setCreateError("Password must be at least 8 characters.");
      return;
    }
    setCreating(true);
    try {
      await apiRequest("POST", "/api/admin/users", {
        email: newEmail.trim().toLowerCase(),
        password: newPassword,
        role: newRole,
      });
      setCreatedCredentials({ email: newEmail.trim().toLowerCase(), password: newPassword });
      await queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Could not create user");
    } finally {
      setCreating(false);
    }
  }

  function copy(value: string, field: "email" | "password" | "combo") {
    navigator.clipboard.writeText(value);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 1500);
  }

  // Reset password dialog
  const [resetUser, setResetUser] = useState<PublicUser | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [resetting, setResetting] = useState(false);

  async function handleReset() {
    if (!resetUser) return;
    if (resetPassword.length < 8) {
      toast({
        title: "Password too short",
        description: "Must be at least 8 characters.",
        variant: "destructive",
      });
      return;
    }
    setResetting(true);
    try {
      await apiRequest("POST", `/api/admin/users/${resetUser.id}/reset-password`, {
        newPassword: resetPassword,
      });
      toast({
        title: "Password reset",
        description: `${resetUser.email} will be asked to set a new password on next sign-in.`,
      });
      setResetUser(null);
      setResetPassword("");
      await queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
    } catch (err) {
      toast({
        title: "Could not reset password",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setResetting(false);
    }
  }

  // Delete confirm
  const [deleteUser, setDeleteUser] = useState<PublicUser | null>(null);
  async function handleDelete() {
    if (!deleteUser) return;
    try {
      await apiRequest("DELETE", `/api/admin/users/${deleteUser.id}`);
      toast({ title: "User removed", description: deleteUser.email });
      setDeleteUser(null);
      await queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
    } catch (err) {
      toast({
        title: "Could not remove user",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    }
  }

  async function handleRoleChange(user: PublicUser, role: "admin" | "member") {
    try {
      await apiRequest("POST", `/api/admin/users/${user.id}/role`, { role });
      toast({ title: "Role updated", description: `${user.email} is now ${role}.` });
      await queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
    } catch (err) {
      toast({
        title: "Could not change role",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    }
  }

  if (me?.role !== "admin") {
    return (
      <div className="mx-auto max-w-3xl px-6 py-12">
        <Card className="p-8">
          <h1 className="text-lg font-semibold">Admin only</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This page is restricted to admin accounts.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight">
            <Users className="h-5 w-5" />
            User accounts
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Anyone with an account here can sign in to the audit engine and see
            all audits. Create one account per teammate.
          </p>
        </div>
        <Button
          onClick={() => {
            resetCreateDialog();
            setCreateOpen(true);
          }}
          className="bg-accent text-accent-foreground hover:bg-accent/90"
          data-testid="button-create-user"
        >
          <Plus className="mr-1.5 h-4 w-4" />
          Add user
        </Button>
      </div>

      <Card className="mt-6 overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 text-left">Email</th>
                <th className="px-4 py-2 text-left">Role</th>
                <th className="px-4 py-2 text-left">Last sign-in</th>
                <th className="px-4 py-2 text-left">Status</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(data?.users || []).map((u) => {
                const isMe = u.email === me?.email;
                return (
                  <tr key={u.id} className="border-t border-border/60">
                    <td className="px-4 py-3 font-medium">
                      {u.email}
                      {isMe && (
                        <Badge variant="secondary" className="ml-2 text-[10px]">
                          you
                        </Badge>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {isMe ? (
                        <Badge variant="default" className="text-xs">
                          {u.role}
                        </Badge>
                      ) : (
                        <Select
                          value={u.role}
                          onValueChange={(v) => handleRoleChange(u, v as "admin" | "member")}
                        >
                          <SelectTrigger className="h-8 w-[110px] text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="admin">admin</SelectItem>
                            <SelectItem value="member">member</SelectItem>
                          </SelectContent>
                        </Select>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {fmtDate(u.lastLoginAt)}
                    </td>
                    <td className="px-4 py-3">
                      {u.mustChange ? (
                        <Badge variant="outline" className="border-amber-500 text-xs text-amber-700">
                          Pending first sign-in
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="text-xs">
                          <UserCheck className="mr-1 h-3 w-3" />
                          Active
                        </Badge>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 text-xs"
                          onClick={() => {
                            setResetUser(u);
                            setResetPassword(generatePassword());
                          }}
                          data-testid={`button-reset-${u.id}`}
                        >
                          <KeyRound className="mr-1 h-3.5 w-3.5" />
                          Reset password
                        </Button>
                        {!isMe && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-8 text-xs text-destructive hover:bg-destructive/10"
                            onClick={() => setDeleteUser(u)}
                            data-testid={`button-delete-${u.id}`}
                          >
                            <Trash2 className="mr-1 h-3.5 w-3.5" />
                            Remove
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {(data?.users || []).length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    No users yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </Card>

      {/* Create dialog */}
      <Dialog
        open={createOpen}
        onOpenChange={(o) => {
          setCreateOpen(o);
          if (!o) resetCreateDialog();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Plus className="h-5 w-5" />
              {createdCredentials ? "User created" : "Add a new user"}
            </DialogTitle>
            <DialogDescription>
              {createdCredentials
                ? "Share these credentials with the user. The password will not be shown again."
                : "Create an account for a teammate. They will be asked to set their own password on first sign-in."}
            </DialogDescription>
          </DialogHeader>

          {createdCredentials ? (
            <div className="space-y-3">
              <div>
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                  Email
                </Label>
                <div className="mt-1 flex items-center gap-2">
                  <Input value={createdCredentials.email} readOnly className="font-mono text-sm" />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => copy(createdCredentials.email, "email")}
                  >
                    {copiedField === "email" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
              <div>
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                  Temporary password
                </Label>
                <div className="mt-1 flex items-center gap-2">
                  <Input value={createdCredentials.password} readOnly className="font-mono text-sm" />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => copy(createdCredentials.password, "password")}
                  >
                    {copiedField === "password" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
              <Button
                variant="secondary"
                className="w-full"
                onClick={() =>
                  copy(
                    `Email: ${createdCredentials.email}\nPassword: ${createdCredentials.password}\nSign in: ${window.location.origin}`,
                    "combo",
                  )
                }
              >
                {copiedField === "combo" ? (
                  <>
                    <Check className="mr-1.5 h-4 w-4" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="mr-1.5 h-4 w-4" />
                    Copy email + password + URL
                  </>
                )}
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <Label htmlFor="newEmail">Email</Label>
                <Input
                  id="newEmail"
                  type="email"
                  autoFocus
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  placeholder="teammate@example.com"
                  className="mt-1"
                  data-testid="input-new-user-email"
                />
              </div>
              <div>
                <Label htmlFor="newUserPassword">Temporary password</Label>
                <div className="mt-1 flex items-center gap-2">
                  <Input
                    id="newUserPassword"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="font-mono text-sm"
                    data-testid="input-new-user-password"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setNewPassword(generatePassword())}
                  >
                    Generate
                  </Button>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  At least 8 characters. The user will set their own password on first sign-in.
                </p>
              </div>
              <div>
                <Label>Role</Label>
                <Select value={newRole} onValueChange={(v) => setNewRole(v as "admin" | "member")}>
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="member">Member, can use the engine</SelectItem>
                    <SelectItem value="admin">Admin, can also manage users</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {createError && <p className="text-xs text-destructive">{createError}</p>}
            </div>
          )}

          <DialogFooter>
            {createdCredentials ? (
              <Button onClick={() => setCreateOpen(false)}>Done</Button>
            ) : (
              <>
                <Button variant="outline" onClick={() => setCreateOpen(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={handleCreate}
                  disabled={creating}
                  className="bg-accent text-accent-foreground hover:bg-accent/90"
                >
                  {creating ? (
                    <>
                      <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                      Creating...
                    </>
                  ) : (
                    <>
                      <ShieldCheck className="mr-1.5 h-4 w-4" />
                      Create user
                    </>
                  )}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reset password dialog */}
      <Dialog open={!!resetUser} onOpenChange={(o) => !o && setResetUser(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reset password</DialogTitle>
            <DialogDescription>
              Set a new temporary password for{" "}
              <span className="font-medium text-foreground">{resetUser?.email}</span>. They will be
              asked to change it on next sign-in.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>New temporary password</Label>
              <div className="mt-1 flex items-center gap-2">
                <Input
                  value={resetPassword}
                  onChange={(e) => setResetPassword(e.target.value)}
                  className="font-mono text-sm"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setResetPassword(generatePassword())}
                >
                  Generate
                </Button>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetUser(null)}>
              Cancel
            </Button>
            <Button onClick={handleReset} disabled={resetting}>
              {resetting ? (
                <>
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                "Reset password"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={!!deleteUser} onOpenChange={(o) => !o && setDeleteUser(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove user</DialogTitle>
            <DialogDescription>
              Permanently remove{" "}
              <span className="font-medium text-foreground">{deleteUser?.email}</span>? They will
              lose access immediately. Their audits remain in the shared workspace.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteUser(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete}>
              <Trash2 className="mr-1.5 h-4 w-4" />
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
