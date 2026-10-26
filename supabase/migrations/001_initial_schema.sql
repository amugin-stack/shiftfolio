-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- PROFILES (mirrors auth.users)
-- ============================================================
CREATE TABLE profiles (
  id         UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email      TEXT NOT NULL UNIQUE,
  full_name  TEXT,
  role       TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Auto-create profile row when a new user signs up
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    'user'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Allow auth admin role to insert into profiles via the trigger
GRANT INSERT ON public.profiles TO supabase_auth_admin;

-- ============================================================
-- HOSTS
-- ============================================================
CREATE TABLE hosts (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name       TEXT NOT NULL,
  email      TEXT,
  user_id    UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- BRANDS
-- ============================================================
CREATE TABLE brands (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name       TEXT NOT NULL,
  email      TEXT,
  user_id    UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- STREAMS
-- ============================================================
CREATE TABLE streams (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title      TEXT NOT NULL,
  brand_id   UUID NOT NULL REFERENCES brands(id) ON DELETE RESTRICT,
  host_id    UUID NOT NULL REFERENCES hosts(id) ON DELETE RESTRICT,
  start_time TIMESTAMPTZ NOT NULL,
  end_time   TIMESTAMPTZ NOT NULL,
  notes      TEXT,
  created_by UUID NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT valid_time_range CHECK (end_time > start_time)
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX idx_streams_start_time ON streams(start_time);
CREATE INDEX idx_streams_brand_id   ON streams(brand_id);
CREATE INDEX idx_streams_host_id    ON streams(host_id);
CREATE INDEX idx_hosts_user_id      ON hosts(user_id);
CREATE INDEX idx_brands_user_id     ON brands(user_id);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE hosts    ENABLE ROW LEVEL SECURITY;
ALTER TABLE brands   ENABLE ROW LEVEL SECURITY;
ALTER TABLE streams  ENABLE ROW LEVEL SECURITY;

-- Helper: check if the current caller is an admin
CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid() AND role = 'admin'
  );
$$;

-- ---- profiles ----
CREATE POLICY "profiles_select"
  ON profiles FOR SELECT
  USING (id = auth.uid() OR is_admin());

CREATE POLICY "profiles_update_own"
  ON profiles FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

CREATE POLICY "profiles_admin_all"
  ON profiles FOR ALL
  USING (is_admin());

-- ---- hosts ----
CREATE POLICY "hosts_select_authenticated"
  ON hosts FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "hosts_insert_admin"
  ON hosts FOR INSERT
  WITH CHECK (is_admin());

CREATE POLICY "hosts_update_admin"
  ON hosts FOR UPDATE
  USING (is_admin());

CREATE POLICY "hosts_delete_admin"
  ON hosts FOR DELETE
  USING (is_admin());

-- ---- brands ----
CREATE POLICY "brands_select_authenticated"
  ON brands FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "brands_insert_admin"
  ON brands FOR INSERT
  WITH CHECK (is_admin());

CREATE POLICY "brands_update_admin"
  ON brands FOR UPDATE
  USING (is_admin());

CREATE POLICY "brands_delete_admin"
  ON brands FOR DELETE
  USING (is_admin());

-- ---- streams ----
-- Admins see all; hosts/brands see only streams they are linked to
CREATE POLICY "streams_select"
  ON streams FOR SELECT
  USING (
    is_admin()
    OR auth.uid() IN (
      SELECT user_id FROM hosts  WHERE id = streams.host_id  AND user_id IS NOT NULL
      UNION
      SELECT user_id FROM brands WHERE id = streams.brand_id AND user_id IS NOT NULL
    )
    OR created_by = auth.uid()
  );

CREATE POLICY "streams_insert_admin"
  ON streams FOR INSERT
  WITH CHECK (is_admin());

CREATE POLICY "streams_update_admin"
  ON streams FOR UPDATE
  USING (is_admin());

CREATE POLICY "streams_delete_admin"
  ON streams FOR DELETE
  USING (is_admin());

-- ============================================================
-- Admin role assignment is intentionally omitted from the portfolio sample.
-- ============================================================
