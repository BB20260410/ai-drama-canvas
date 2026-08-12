import { spawn } from "node:child_process";

const PYTHON = "/usr/bin/python3";
const TIMEOUT_MS = 30_000;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;

const HELPER = String.raw`
import ctypes, errno, fcntl, hashlib, json, os, stat, sys, uuid

F_GETPATH = 50
RENAME_EXCL = 0x00000004
RENAME_NOFOLLOW_ANY = 0x00000010

def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")

def fd_path(fd):
    return fcntl.fcntl(fd, F_GETPATH, b"\0" * 1024).split(b"\0", 1)[0].decode("utf-8")

def basename(value):
    if not value or os.path.basename(value) != value or value in (".", ".."):
        raise ValueError("managed file name must be one basename")
    return value

def open_exact_directory(expected_path, expected_canonical, expected_dev, expected_ino):
    try:
        fd = os.open(expected_path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except OSError as error:
        raise OSError(errno.ESTALE, "directory identity mismatch") from error
    current = os.fstat(fd)
    actual = fd_path(fd)
    if actual != expected_canonical or str(current.st_dev) != expected_dev or str(current.st_ino) != expected_ino:
        os.close(fd)
        raise OSError(errno.ESTALE, "directory identity mismatch")
    return fd

def file_digest(fd):
    before = os.fstat(fd)
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
        raise RuntimeError("managed file must be a single-link regular file")
    os.lseek(fd, 0, os.SEEK_SET)
    digest = hashlib.sha256()
    size = 0
    while True:
        chunk = os.read(fd, 1024 * 1024)
        if not chunk:
            break
        digest.update(chunk)
        size += len(chunk)
    after = os.fstat(fd)
    if (before.st_dev, before.st_ino, before.st_nlink, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
        after.st_dev, after.st_ino, after.st_nlink, after.st_size, after.st_mtime_ns, after.st_ctime_ns
    ) or size != before.st_size:
        raise RuntimeError("managed file changed while hashing")
    return digest.hexdigest(), size, before

def inspect_existing(directory_fd, name, expected_sha, expected_size):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory_fd)
    try:
        digest, size, metadata = file_digest(fd)
        if digest != expected_sha or size != expected_size:
            raise FileExistsError(errno.EEXIST, "existing managed file has different content", name)
        return {
            "created": False,
            "dev": str(metadata.st_dev),
            "ino": str(metadata.st_ino),
            "nlink": metadata.st_nlink,
            "size": size,
            "sha256": digest,
        }
    finally:
        os.close(fd)

def exact_directory_receipt(fd):
    metadata = os.fstat(fd)
    return {
        "canonicalDirectory": fd_path(fd),
        "dev": str(metadata.st_dev),
        "ino": str(metadata.st_ino),
    }

def action_ensure(args):
    root_path, canonical_root, root_dev, root_ino, relative_path, mode_text = args
    if os.path.isabs(relative_path) or relative_path in (".", ".."):
        raise ValueError("managed relative directory is invalid")
    segments = [] if relative_path == "" else relative_path.split(os.sep)
    if any(not item or item in (".", "..") or os.path.basename(item) != item for item in segments):
        raise ValueError("managed relative directory contains invalid segment")
    current = open_exact_directory(root_path, canonical_root, root_dev, root_ino)
    mode = int(mode_text, 8)
    try:
        for segment in segments:
            try:
                os.mkdir(segment, mode=mode, dir_fd=current)
                os.fsync(current)
            except FileExistsError:
                pass
            child = os.open(segment, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
            child_stat = os.fstat(child)
            if not stat.S_ISDIR(child_stat.st_mode):
                os.close(child)
                raise RuntimeError("managed directory segment is not a directory")
            os.close(current)
            current = child
        receipt = exact_directory_receipt(current)
        if os.path.commonpath([receipt["canonicalDirectory"], canonical_root]) != canonical_root:
            raise RuntimeError("managed directory escaped canonical project root")
        return receipt
    finally:
        os.close(current)

def action_inspect_directory(args):
    root_path, canonical_root, root_dev, root_ino, relative_path = args
    if os.path.isabs(relative_path) or relative_path in (".", ".."):
        raise ValueError("managed relative directory is invalid")
    segments = [] if relative_path == "" else relative_path.split(os.sep)
    if any(not item or item in (".", "..") or os.path.basename(item) != item for item in segments):
        raise ValueError("managed relative directory contains invalid segment")
    current = open_exact_directory(root_path, canonical_root, root_dev, root_ino)
    try:
        for segment in segments:
            child = os.open(segment, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
            child_stat = os.fstat(child)
            if not stat.S_ISDIR(child_stat.st_mode):
                os.close(child)
                raise RuntimeError("managed directory segment is not a directory")
            os.close(current)
            current = child
        receipt = exact_directory_receipt(current)
        if os.path.commonpath([receipt["canonicalDirectory"], canonical_root]) != canonical_root:
            raise RuntimeError("managed directory escaped canonical project root")
        return receipt
    finally:
        os.close(current)

def rename_no_replace(source_directory_fd, source_name, target_directory_fd, target_name):
    libc = ctypes.CDLL(None, use_errno=True)
    renameatx_np = libc.renameatx_np
    renameatx_np.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    renameatx_np.restype = ctypes.c_int
    result = renameatx_np(
        source_directory_fd,
        os.fsencode(source_name),
        target_directory_fd,
        os.fsencode(target_name),
        RENAME_EXCL | RENAME_NOFOLLOW_ANY,
    )
    if result != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code), target_name)

def rename_replace(source_directory_fd, source_name, target_directory_fd, target_name):
    libc = ctypes.CDLL(None, use_errno=True)
    renameatx_np = libc.renameatx_np
    renameatx_np.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    renameatx_np.restype = ctypes.c_int
    result = renameatx_np(
        source_directory_fd,
        os.fsencode(source_name),
        target_directory_fd,
        os.fsencode(target_name),
        RENAME_NOFOLLOW_ANY,
    )
    if result != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code), target_name)

def action_persist(args):
    directory_path, canonical_directory, directory_dev, directory_ino, target_name, expected_sha, expected_size_text, mode_text = args
    target_name = basename(target_name)
    expected_size = int(expected_size_text)
    if expected_size < 0:
        raise ValueError("managed persisted byte size is invalid")
    directory_fd = open_exact_directory(directory_path, canonical_directory, directory_dev, directory_ino)
    temporary_name = ".aicanvas-dirfd-" + uuid.uuid4().hex + ".tmp"
    temporary_fd = None
    temporary_exists = False
    committed = False
    try:
        try:
            return inspect_existing(directory_fd, target_name, expected_sha, expected_size)
        except FileNotFoundError:
            pass
        temporary_fd = os.open(
            temporary_name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            int(mode_text, 8),
            dir_fd=directory_fd,
        )
        temporary_exists = True
        digest = hashlib.sha256()
        size = 0
        while True:
            chunk = sys.stdin.buffer.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            size += len(chunk)
            view = memoryview(chunk)
            while view:
                written = os.write(temporary_fd, view)
                view = view[written:]
        if size != expected_size or digest.hexdigest() != expected_sha:
            raise RuntimeError("stdin bytes do not match declared identity")
        os.fsync(temporary_fd)
        os.close(temporary_fd)
        temporary_fd = None
        if fd_path(directory_fd) != canonical_directory:
            raise RuntimeError("directory identity changed before commit")
        try:
            rename_no_replace(directory_fd, temporary_name, directory_fd, target_name)
            temporary_exists = False
            committed = True
        except FileExistsError:
            os.unlink(temporary_name, dir_fd=directory_fd)
            temporary_exists = False
            return inspect_existing(directory_fd, target_name, expected_sha, expected_size)
        os.fsync(directory_fd)
        final = inspect_existing(directory_fd, target_name, expected_sha, expected_size)
        final["created"] = True
        return final
    except BaseException:
        if temporary_fd is not None:
            os.close(temporary_fd)
        if temporary_exists and not committed:
            try:
                os.unlink(temporary_name, dir_fd=directory_fd)
                os.fsync(directory_fd)
            except FileNotFoundError:
                pass
        raise
    finally:
        os.close(directory_fd)

def action_persist_batch(args):
    if len(args) < 8:
        raise ValueError("persist-batch arguments are incomplete")
    directory_path, canonical_directory, directory_dev, directory_ino, commit_name, interrupt_name, mode_text, count_text = args[:8]
    count = int(count_text)
    if count < 1 or count > 64 or len(args) != 8 + count * 3:
        raise ValueError("persist-batch file count is invalid")
    specs = []
    seen = set()
    for index in range(count):
        offset = 8 + index * 3
        name = basename(args[offset])
        expected_sha = args[offset + 1]
        expected_size = int(args[offset + 2])
        if name in seen or len(expected_sha) != 64 or expected_size < 0:
            raise ValueError("persist-batch file contract is invalid")
        seen.add(name)
        specs.append((name, expected_sha, expected_size))
    if commit_name != "-":
        commit_name = basename(commit_name)
        if commit_name not in seen or specs[-1][0] != commit_name:
            raise ValueError("persist-batch commit file must be the final entry")
    if interrupt_name != "-" and interrupt_name not in seen:
        raise ValueError("persist-batch interrupt file is not in the batch")

    def read_exact(size):
        chunks = []
        remaining = size
        while remaining:
            chunk = sys.stdin.buffer.read(min(1024 * 1024, remaining))
            if not chunk:
                raise RuntimeError("persist-batch stdin ended early")
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    directory_fd = open_exact_directory(directory_path, canonical_directory, directory_dev, directory_ino)
    mode = int(mode_text, 8)
    receipts = []
    try:
        for index, (name, expected_sha, expected_size) in enumerate(specs):
            data = read_exact(expected_size)
            if hashlib.sha256(data).hexdigest() != expected_sha:
                raise RuntimeError("persist-batch stdin bytes do not match declared identity")
            try:
                existing = inspect_existing(directory_fd, name, expected_sha, expected_size)
                receipts.append({"name": name, **existing})
            except FileNotFoundError:
                temporary_name = ".aicanvas-dirfd-" + uuid.uuid4().hex + ".tmp"
                temporary_fd = None
                temporary_exists = False
                committed = False
                try:
                    temporary_fd = os.open(
                        temporary_name,
                        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                        mode,
                        dir_fd=directory_fd,
                    )
                    temporary_exists = True
                    view = memoryview(data)
                    while view:
                        written = os.write(temporary_fd, view)
                        view = view[written:]
                    os.fsync(temporary_fd)
                    os.close(temporary_fd)
                    temporary_fd = None
                    if fd_path(directory_fd) != canonical_directory:
                        raise RuntimeError("directory identity changed before batch commit")
                    try:
                        rename_no_replace(directory_fd, temporary_name, directory_fd, name)
                        temporary_exists = False
                        committed = True
                        final = inspect_existing(directory_fd, name, expected_sha, expected_size)
                        final["created"] = True
                        receipts.append({"name": name, **final})
                    except FileExistsError:
                        os.unlink(temporary_name, dir_fd=directory_fd)
                        temporary_exists = False
                        receipts.append({"name": name, **inspect_existing(directory_fd, name, expected_sha, expected_size)})
                except BaseException:
                    if temporary_fd is not None:
                        os.close(temporary_fd)
                    if temporary_exists and not committed:
                        try:
                            os.unlink(temporary_name, dir_fd=directory_fd)
                        except FileNotFoundError:
                            pass
                    raise
            if commit_name != "-" and index == count - 2:
                os.fsync(directory_fd)
            if interrupt_name == name:
                raise RuntimeError("test-only persist-batch interruption after " + name)
        if sys.stdin.buffer.read(1):
            raise RuntimeError("persist-batch stdin contains trailing bytes")
        os.fsync(directory_fd)
        return {"files": receipts}
    finally:
        os.close(directory_fd)

def action_replace(args):
    (directory_path, canonical_directory, directory_dev, directory_ino, target_name,
     old_dev, old_ino, old_sha, old_size_text, new_sha, new_size_text, mode_text) = args
    target_name = basename(target_name)
    old_size = int(old_size_text)
    new_size = int(new_size_text)
    if old_size < 0 or new_size < 0 or old_sha == new_sha:
        raise ValueError("managed replacement requires distinct valid revisions")
    directory_fd = open_exact_directory(directory_path, canonical_directory, directory_dev, directory_ino)
    temporary_name = ".aicanvas-replace-" + uuid.uuid4().hex + ".tmp"
    temporary_fd = None
    temporary_exists = False
    committed = False
    try:
        current_fd = os.open(target_name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory_fd)
        try:
            digest, size, metadata = file_digest(current_fd)
            if (str(metadata.st_dev), str(metadata.st_ino), digest, size) != (old_dev, old_ino, old_sha, old_size):
                raise RuntimeError("managed replacement CAS mismatch")
        finally:
            os.close(current_fd)
        temporary_fd = os.open(
            temporary_name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            int(mode_text, 8),
            dir_fd=directory_fd,
        )
        temporary_exists = True
        digest = hashlib.sha256()
        size = 0
        while True:
            chunk = sys.stdin.buffer.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            size += len(chunk)
            view = memoryview(chunk)
            while view:
                written = os.write(temporary_fd, view)
                view = view[written:]
        if size != new_size or digest.hexdigest() != new_sha:
            raise RuntimeError("replacement stdin bytes do not match declared identity")
        os.fsync(temporary_fd)
        os.close(temporary_fd)
        temporary_fd = None

        # CAS 必须在提交点紧前再验一次；受信写者另有项目锁串行。
        current_fd = os.open(target_name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory_fd)
        try:
            digest, size, metadata = file_digest(current_fd)
            if (str(metadata.st_dev), str(metadata.st_ino), digest, size) != (old_dev, old_ino, old_sha, old_size):
                raise RuntimeError("managed replacement CAS changed before commit")
        finally:
            os.close(current_fd)
        if fd_path(directory_fd) != canonical_directory:
            raise RuntimeError("directory identity changed before replacement commit")
        rename_replace(directory_fd, temporary_name, directory_fd, target_name)
        temporary_exists = False
        committed = True
        os.fsync(directory_fd)
        final = inspect_existing(directory_fd, target_name, new_sha, new_size)
        final["created"] = True
        return final
    except BaseException:
        if temporary_fd is not None:
            os.close(temporary_fd)
        if temporary_exists and not committed:
            try:
                os.unlink(temporary_name, dir_fd=directory_fd)
                os.fsync(directory_fd)
            except FileNotFoundError:
                pass
        raise
    finally:
        os.close(directory_fd)

def action_move(args):
    (source_path, source_canonical, source_dir_dev, source_dir_ino, source_name,
     source_dev, source_ino, expected_sha, expected_size_text,
     target_path, target_canonical, target_dir_dev, target_dir_ino, target_name) = args
    source_name = basename(source_name)
    target_name = basename(target_name)
    expected_size = int(expected_size_text)
    source_fd = open_exact_directory(source_path, source_canonical, source_dir_dev, source_dir_ino)
    target_fd = open_exact_directory(target_path, target_canonical, target_dir_dev, target_dir_ino)
    committed = False
    try:
        opened = os.open(source_name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=source_fd)
        try:
            digest, size, metadata = file_digest(opened)
            if (str(metadata.st_dev), str(metadata.st_ino), digest, size) != (
                source_dev, source_ino, expected_sha, expected_size
            ):
                raise RuntimeError("managed move source CAS mismatch")
        finally:
            os.close(opened)
        try:
            os.stat(target_name, dir_fd=target_fd, follow_symlinks=False)
            raise FileExistsError(errno.EEXIST, "managed move target already exists", target_name)
        except FileNotFoundError:
            pass
        rename_no_replace(source_fd, source_name, target_fd, target_name)
        committed = True
        os.fsync(source_fd)
        if target_fd != source_fd:
            os.fsync(target_fd)
        final = inspect_existing(target_fd, target_name, expected_sha, expected_size)
        if str(final["dev"]) != source_dev or str(final["ino"]) != source_ino:
            raise RuntimeError("managed move receipt identity mismatch")
        final["moved"] = True
        return final
    except BaseException:
        if committed:
            # rename 已是提交点；状态不明时禁止路径式回滚。
            pass
        raise
    finally:
        os.close(source_fd)
        os.close(target_fd)

def action_move_directory(args):
    (source_parent_path, source_parent_canonical, source_parent_dev, source_parent_ino,
     source_name, source_dev, source_ino,
     target_parent_path, target_parent_canonical, target_parent_dev, target_parent_ino, target_name) = args
    source_name = basename(source_name)
    target_name = basename(target_name)
    source_parent_fd = open_exact_directory(
        source_parent_path, source_parent_canonical, source_parent_dev, source_parent_ino
    )
    target_parent_fd = open_exact_directory(
        target_parent_path, target_parent_canonical, target_parent_dev, target_parent_ino
    )
    try:
        source_metadata = os.stat(source_name, dir_fd=source_parent_fd, follow_symlinks=False)
        if not stat.S_ISDIR(source_metadata.st_mode) or str(source_metadata.st_dev) != source_dev or str(source_metadata.st_ino) != source_ino:
            raise RuntimeError("managed directory move source identity mismatch")
        try:
            os.stat(target_name, dir_fd=target_parent_fd, follow_symlinks=False)
            raise FileExistsError(errno.EEXIST, "managed directory move target already exists", target_name)
        except FileNotFoundError:
            pass
        rename_no_replace(source_parent_fd, source_name, target_parent_fd, target_name)
        os.fsync(source_parent_fd)
        if target_parent_fd != source_parent_fd:
            os.fsync(target_parent_fd)
        target_metadata = os.stat(target_name, dir_fd=target_parent_fd, follow_symlinks=False)
        if not stat.S_ISDIR(target_metadata.st_mode) or target_metadata.st_dev != source_metadata.st_dev or target_metadata.st_ino != source_metadata.st_ino:
            raise RuntimeError("managed directory move target identity mismatch")
        return {
            "moved": True,
            "dev": str(target_metadata.st_dev),
            "ino": str(target_metadata.st_ino),
        }
    finally:
        os.close(source_parent_fd)
        os.close(target_parent_fd)

def action_create(args):
    directory_path, canonical_directory, directory_dev, directory_ino, target_name, mode_text = args
    target_name = basename(target_name)
    directory_fd = open_exact_directory(directory_path, canonical_directory, directory_dev, directory_ino)
    fd = None
    try:
        fd = os.open(
            target_name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            int(mode_text, 8),
            dir_fd=directory_fd,
        )
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            raise RuntimeError("exclusive managed file is not single-link regular")
        os.fsync(fd)
        os.fsync(directory_fd)
        return {"created": True, "dev": str(metadata.st_dev), "ino": str(metadata.st_ino), "nlink": metadata.st_nlink, "size": metadata.st_size}
    finally:
        if fd is not None:
            os.close(fd)
        os.close(directory_fd)

def action_import(args):
    (source_path, source_dev, source_ino, source_size, source_mtime_ns, source_ctime_ns,
     object_root_path, object_root_canonical, object_root_dev, object_root_ino, expected_sha, mode_text) = args
    source_fd = os.open(source_path, os.O_RDONLY | os.O_NOFOLLOW)
    object_root_fd = open_exact_directory(object_root_path, object_root_canonical, object_root_dev, object_root_ino)
    temporary_name = ".aicanvas-import-" + uuid.uuid4().hex + ".tmp"
    temporary_fd = None
    temporary_exists = False
    committed = False
    prefix_fd = None
    try:
        source_before = os.fstat(source_fd)
        if not stat.S_ISREG(source_before.st_mode) or source_before.st_nlink != 1 or fd_path(source_fd) != source_path:
            raise RuntimeError("media source is not a stable regular file")
        expected_identity = (source_dev, source_ino, source_size, source_mtime_ns, source_ctime_ns)
        actual_identity = tuple(str(value) for value in (
            source_before.st_dev, source_before.st_ino, source_before.st_size,
            source_before.st_mtime_ns, source_before.st_ctime_ns,
        ))
        if actual_identity != expected_identity:
            raise RuntimeError("media source identity changed before import")
        temporary_fd = os.open(
            temporary_name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            int(mode_text, 8),
            dir_fd=object_root_fd,
        )
        temporary_exists = True
        digest = hashlib.sha256()
        size = 0
        while True:
            chunk = os.read(source_fd, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            size += len(chunk)
            view = memoryview(chunk)
            while view:
                written = os.write(temporary_fd, view)
                view = view[written:]
        source_after = os.fstat(source_fd)
        actual_after = tuple(str(value) for value in (
            source_after.st_dev, source_after.st_ino, source_after.st_size,
            source_after.st_mtime_ns, source_after.st_ctime_ns,
        ))
        sha = digest.hexdigest()
        if actual_after != expected_identity or size != source_before.st_size:
            raise RuntimeError("media source changed while importing")
        if expected_sha != "-" and sha != expected_sha:
            raise RuntimeError("media source sha256 mismatch:" + sha)
        os.fsync(temporary_fd)
        os.close(temporary_fd)
        temporary_fd = None
        prefix = sha[:2]
        try:
            os.mkdir(prefix, mode=0o700, dir_fd=object_root_fd)
            os.fsync(object_root_fd)
        except FileExistsError:
            pass
        prefix_fd = os.open(prefix, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=object_root_fd)
        try:
            existing = inspect_existing(prefix_fd, sha, sha, size)
            os.unlink(temporary_name, dir_fd=object_root_fd)
            temporary_exists = False
            return {**existing, "sha256": sha, "size": size}
        except FileNotFoundError:
            pass
        try:
            rename_no_replace(object_root_fd, temporary_name, prefix_fd, sha)
            temporary_exists = False
            committed = True
        except FileExistsError:
            os.unlink(temporary_name, dir_fd=object_root_fd)
            temporary_exists = False
            existing = inspect_existing(prefix_fd, sha, sha, size)
            return {**existing, "sha256": sha, "size": size}
        os.fsync(prefix_fd)
        os.fsync(object_root_fd)
        final = inspect_existing(prefix_fd, sha, sha, size)
        final["created"] = True
        return {**final, "sha256": sha, "size": size}
    except BaseException:
        if temporary_fd is not None:
            os.close(temporary_fd)
        if temporary_exists and not committed:
            try:
                os.unlink(temporary_name, dir_fd=object_root_fd)
                os.fsync(object_root_fd)
            except FileNotFoundError:
                pass
        raise
    finally:
        if prefix_fd is not None:
            os.close(prefix_fd)
        os.close(source_fd)
        os.close(object_root_fd)

def action_unlink(args):
    directory_path, canonical_directory, directory_dev, directory_ino, target_name, file_dev, file_ino = args
    target_name = basename(target_name)
    directory_fd = open_exact_directory(directory_path, canonical_directory, directory_dev, directory_ino)
    try:
        try:
            metadata = os.stat(target_name, dir_fd=directory_fd, follow_symlinks=False)
        except FileNotFoundError:
            return {"removed": False}
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1 or str(metadata.st_dev) != file_dev or str(metadata.st_ino) != file_ino:
            raise RuntimeError("managed unlink identity mismatch")
        os.unlink(target_name, dir_fd=directory_fd)
        os.fsync(directory_fd)
        return {"removed": True}
    finally:
        os.close(directory_fd)

def action_link(args):
    (source_path, source_canonical, source_dir_dev, source_dir_ino, source_name, source_dev, source_ino,
     target_path, target_canonical, target_dir_dev, target_dir_ino, target_name) = args
    source_name = basename(source_name)
    target_name = basename(target_name)
    source_fd = open_exact_directory(source_path, source_canonical, source_dir_dev, source_dir_ino)
    target_fd = open_exact_directory(target_path, target_canonical, target_dir_dev, target_dir_ino)
    try:
        source_metadata = os.stat(source_name, dir_fd=source_fd, follow_symlinks=False)
        if not stat.S_ISREG(source_metadata.st_mode) or str(source_metadata.st_dev) != source_dev or str(source_metadata.st_ino) != source_ino:
            raise RuntimeError("managed link source identity mismatch")
        try:
            os.link(source_name, target_name, src_dir_fd=source_fd, dst_dir_fd=target_fd, follow_symlinks=False)
        except FileExistsError:
            return {"created": False}
        target_metadata = os.stat(target_name, dir_fd=target_fd, follow_symlinks=False)
        if not stat.S_ISREG(target_metadata.st_mode) or target_metadata.st_dev != source_metadata.st_dev or target_metadata.st_ino != source_metadata.st_ino:
            raise RuntimeError("managed link target identity mismatch")
        os.fsync(target_fd)
        return {"created": True}
    finally:
        os.close(source_fd)
        os.close(target_fd)

def main():
    action = sys.argv[1]
    args = sys.argv[2:]
    if action == "ensure": return action_ensure(args)
    if action == "inspect-directory": return action_inspect_directory(args)
    if action == "persist": return action_persist(args)
    if action == "persist-batch": return action_persist_batch(args)
    if action == "replace": return action_replace(args)
    if action == "move": return action_move(args)
    if action == "move-directory": return action_move_directory(args)
    if action == "create": return action_create(args)
    if action == "import": return action_import(args)
    if action == "unlink": return action_unlink(args)
    if action == "link": return action_link(args)
    raise ValueError("unknown dirfd action")

try:
    emit({"ok": True, **main()})
except BaseException as error:
    code = errno.errorcode.get(error.errno, "DIRFD_STORAGE_FAILED") if isinstance(error, OSError) else "DIRFD_STORAGE_FAILED"
    emit({"ok": False, "code": code, "message": str(error)[:4000]})
    raise SystemExit(17)
`;

interface HelperResult {
  ok: boolean;
  code?: string;
  message?: string;
  [key: string]: unknown;
}

function isolatedEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONNOUSERSITE: "1",
  };
}

export async function runDarwinDirfdStorage(
  action: "ensure" | "inspect-directory" | "persist" | "persist-batch" | "replace" | "move" | "move-directory" | "create" | "import" | "unlink" | "link",
  args: readonly string[],
  stdin: Buffer = Buffer.alloc(0),
): Promise<HelperResult> {
  if (process.platform !== "darwin") {
    throw new Error("安全受管写入需要 macOS dirfd helper；禁止回退到路径式写入。");
  }
  return new Promise<HelperResult>((resolve, reject) => {
    const child = spawn(PYTHON, ["-I", "-S", "-c", HELPER, action, ...args], {
      env: isolatedEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error(`dirfd helper ${action} 超时，正式写入状态不明。`)));
    }, TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes <= MAX_DIAGNOSTIC_BYTES) stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes <= MAX_DIAGNOSTIC_BYTES) stderr.push(chunk);
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => finish(() => {
      let result: HelperResult | undefined;
      try {
        result = JSON.parse(Buffer.concat(stdout).toString("utf8").trim()) as HelperResult;
      } catch {
        // 统一落到下方受限诊断，绝不输出 stdin 内容。
      }
      if (code === 0 && result?.ok === true) {
        resolve(result);
        return;
      }
      const error = new Error(
        result?.message
          ? `dirfd helper ${action} 失败：${result.message}`
          : `dirfd helper ${action} 失败（exit=${code ?? "signal"}）：${Buffer.concat(stderr).toString("utf8").slice(0, 2000)}`,
      ) as NodeJS.ErrnoException;
      error.code = result?.code ?? "DIRFD_STORAGE_FAILED";
      reject(error);
    }));
    child.stdin.on("error", (error) => finish(() => reject(error)));
    child.stdin.end(stdin);
  });
}
