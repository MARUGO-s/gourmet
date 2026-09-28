alter table public.snapshots
  alter column rating type numeric(4,2);

alter table public.reviews
  alter column rating type numeric(4,2);