
mod scripts;

#[no_mangle]
pub extern "C" fn aos_contract() -> u32 {
    aos_sim::CONTRACT_VERSION
}

#[no_mangle]
pub extern "C" fn aos_alloc(len: usize) -> *mut u8 {
    aos_core::abi::alloc(len)
}

#[no_mangle]
pub unsafe extern "C" fn aos_free(ptr: *mut u8, len: usize) {
    aos_core::abi::free(ptr, len)
}

#[no_mangle]
pub unsafe extern "C" fn aos_open(ptr: *const u8, len: usize) -> u32 {
    let bytes = core::slice::from_raw_parts(ptr, len);
    let Ok(payload) = core::str::from_utf8(bytes) else {
        return 0;
    };
    aos_core::abi::open(payload, scripts::register);
    1
}

#[no_mangle]
pub unsafe extern "C" fn aos_command(ptr: *const u8, len: usize) -> *const u8 {
    let bytes = core::slice::from_raw_parts(ptr, len);
    let Ok(input) = core::str::from_utf8(bytes) else {
        return aos_core::abi::command("badinput").as_ptr();
    };
    aos_core::abi::command(input).as_ptr()
}
