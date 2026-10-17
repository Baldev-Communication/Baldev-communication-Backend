// Additive product templates for the client's mixed electronics and home store.
// Saved definitions win, so upgrades never replace a store's existing fields.
const field = (key, label, type = 'text', extra = {}) => ({
  key, label, type, unit: '', required: false, filterable: false, searchable: true,
  showOnCard: false, showOnDetail: true, showInSpecifications: true, variant: false,
  options: [], defaultValue: '', sortOrder: 100, group: 'Specifications', validation: {}, ...extra,
});
const number = (key, label, unit = '') => field(key, label, 'measurement', { unit, validation: { min: 0 } });
const choice = (key, label, options) => field(key, label, 'dropdown', { options, filterable: true });
const notes = (key, label) => field(key, label, 'textarea');
const yesNo = (key, label) => field(key, label, 'boolean');
const power = [number('power_consumption', 'Rated power', 'W'), field('voltage', 'Rated voltage / frequency')];
const common = [
  field('brand', 'Brand'), field('model', 'Model / model number'),
  { ...choice('condition', 'Condition', ['New', 'Refurbished', 'Used']), required: true },
  field('warranty', 'Warranty period'), field('dimensions', 'Product dimensions (include unit)'),
  number('weight', 'Product weight', 'kg'), notes('box_contents', 'Included components'),
];
const template = (key, name, attributes) => ({
  key, name, parentKey: '', active: true,
  attributes: [...common, ...attributes].map((item, index) => ({ ...item, sortOrder: 100 + index })),
  variantAttributes: ['colour'], filters: ['brand', 'price', 'availability'],
});
const audio = [
  field('connectivity', 'Connectivity / supported inputs'), number('driver_size', 'Driver size', 'mm'),
  field('frequency_response', 'Frequency response'), number('impedance', 'Impedance', 'ohm'),
  number('battery_life', 'Playback time', 'h'), field('charging_time', 'Charging time'),
  yesNo('microphone', 'Microphone'), field('water_resistance', 'Water resistance rating'),
];
const templates = [
  template('general_products', 'Other products / custom specifications', [
    field('product_type', 'Product type'), field('material', 'Material'), field('capacity', 'Capacity (include unit)'),
    notes('features', 'Features'), notes('usage_instructions', 'Use and care'),
  ]),
  template('televisions', 'Televisions', [
    number('screen_size', 'Screen size', 'in'), field('resolution', 'Display resolution'),
    field('panel_type', 'Panel / display technology'), number('refresh_rate', 'Refresh rate', 'Hz'),
    field('smart_tv_platform', 'Smart TV platform / OS'), yesNo('smart_tv', 'Smart TV'),
    field('hdr_formats', 'HDR formats'), number('audio_output', 'Speaker output', 'W'),
    field('hdmi_ports', 'HDMI ports / version'), field('usb_ports', 'USB ports'),
    field('connectivity', 'Wi-Fi / Bluetooth / other connectivity'), field('casting', 'Casting support'),
    field('vesa_mount', 'VESA mount size'), field('energy_rating', 'Energy rating / label year'),
    notes('installation', 'Installation / wall mount included'), ...power,
  ]),
  template('speakers', 'Speakers & soundbars', [
    field('speaker_type', 'Speaker type'), number('output_power', 'RMS output power', 'W'),
    field('channels', 'Audio channels'), ...audio, number('battery_capacity', 'Battery capacity', 'mAh'),
    yesNo('fm_radio', 'FM radio'), field('supported_formats', 'Supported audio formats'), ...power,
  ]),
  template('headphones', 'Headphones', [
    field('headphone_type', 'Headphone type / fit'), ...audio, yesNo('anc', 'Active noise cancellation'),
    field('audio_codecs', 'Supported codecs'), field('bluetooth', 'Bluetooth version'),
    field('connector_type', 'Connector / charging port'),
  ]),
  template('earphones', 'Earphones & earbuds', [
    ...audio, field('earphone_type', 'Earphone type'), yesNo('anc', 'Active noise cancellation'),
    field('audio_codecs', 'Supported codecs'), field('bluetooth', 'Bluetooth version'),
    field('connector_type', 'Connector / charging port'), field('case_battery_life', 'Playback with charging case'),
  ]),
  template('screen_protectors', 'Screen guards & protectors', [
    field('protector_type', 'Protector type'), notes('compatible_devices', 'Compatible models / exact fit'),
    field('material', 'Material'), field('hardness', 'Hardness rating'), number('thickness', 'Thickness', 'mm'),
    field('coverage', 'Coverage / edge fit'), field('finish', 'Finish / privacy / anti-glare'),
    number('pack_quantity', 'Number in pack'), yesNo('installation_kit', 'Installation kit included'),
  ]),
  template('irons', 'Irons / garment steamers', [
    field('iron_type', 'Iron / steamer type'), ...power, field('soleplate', 'Soleplate material / coating'),
    number('water_tank_capacity', 'Water tank capacity', 'ml'), number('steam_output', 'Steam output', 'g/min'),
    yesNo('temperature_control', 'Adjustable temperature'), yesNo('auto_shutoff', 'Automatic shut-off'),
    number('cord_length', 'Cord length', 'm'), notes('safety_features', 'Safety features'),
  ]),
  template('washing_machines', 'Washing machines', [
    number('wash_capacity', 'Wash capacity', 'kg'), number('dryer_capacity', 'Drying capacity', 'kg'),
    choice('loading_type', 'Loading type', ['Front load', 'Top load']),
    choice('automation', 'Operation', ['Fully automatic', 'Semi automatic', 'Manual']),
    number('spin_speed', 'Maximum spin speed', 'rpm'), field('energy_rating', 'Energy rating / label year'),
    field('motor_type', 'Motor / inverter technology'), field('drum_material', 'Drum material'),
    notes('wash_programs', 'Wash programs'), yesNo('inbuilt_heater', 'Inbuilt heater'),
    number('water_consumption', 'Water consumption per cycle', 'l'), field('noise_level', 'Noise level'),
    notes('installation', 'Installation requirements'), ...power,
  ]),
  template('pressure_cookers', 'Pressure cookers', [
    number('capacity_litres', 'Capacity', 'l'), field('material', 'Body material'),
    choice('lid_type', 'Lid type', ['Inner lid', 'Outer lid', 'Clip-on']),
    field('base_type', 'Base type / thickness'), yesNo('induction_compatible', 'Induction compatible'),
    yesNo('gas_compatible', 'Gas stove compatible'), field('handle_material', 'Handle material'),
    notes('safety_features', 'Safety features'), number('pack_quantity', 'Number in pack'),
    notes('usage_instructions', 'Use and care'),
  ]),
  template('mixer_grinders', 'Mixer grinders / blenders / juicers', [
    field('appliance_type', 'Mixer / blender / juicer type'), ...power,
    number('jar_count', 'Number of jars'), field('jar_capacities', 'Jar capacities (include units)'),
    field('jar_material', 'Jar material'), field('blade_material', 'Blade material'),
    number('speed_settings', 'Speed settings'), number('motor_speed', 'Motor speed', 'rpm'),
    yesNo('pulse_function', 'Pulse function'), yesNo('overload_protection', 'Overload protection'),
    notes('functions', 'Grinding / blending functions'), notes('usage_instructions', 'Use and care'),
  ]),
  template('refrigerators', 'Refrigerators & freezers', [
    number('capacity_litres', 'Total capacity', 'l'), number('freezer_capacity', 'Freezer capacity', 'l'),
    field('refrigerator_type', 'Refrigerator type'), number('door_count', 'Number of doors'),
    field('defrost_type', 'Defrost technology'), field('energy_rating', 'Energy rating / label year'),
    field('compressor_type', 'Compressor type'), field('refrigerant', 'Refrigerant'),
    notes('features', 'Cooling / storage features'), ...power,
  ]),
  template('air_conditioners', 'Air conditioners', [
    field('ac_type', 'AC type'), number('cooling_capacity_ton', 'Cooling capacity', 'ton'),
    field('energy_rating', 'Energy rating / label year'), field('iseer', 'ISEER rating'),
    field('compressor_type', 'Compressor / inverter type'), field('refrigerant', 'Refrigerant'),
    field('room_coverage', 'Recommended room area (include unit)'), field('noise_level', 'Noise level'),
    notes('installation', 'Installation requirements / kit'), ...power,
  ]),
  template('fans_coolers', 'Fans & air coolers', [
    field('appliance_type', 'Fan / cooler type'), ...power, number('sweep_size', 'Fan sweep', 'mm'),
    number('air_delivery', 'Air delivery', 'm3/min'), number('speed_settings', 'Speed settings'),
    number('tank_capacity', 'Cooler tank capacity', 'l'), field('room_coverage', 'Coverage area'),
    yesNo('remote_control', 'Remote control'), notes('features', 'Features'),
  ]),
  template('microwave_ovens', 'Microwaves / ovens / air fryers', [
    field('oven_type', 'Oven / air fryer type'), number('capacity_litres', 'Capacity', 'l'), ...power,
    field('temperature_range', 'Temperature range'), notes('cooking_modes', 'Cooking modes / presets'),
    field('cavity_material', 'Cavity material'), notes('usage_instructions', 'Use and care'),
  ]),
  template('cooktops', 'Induction / gas cooktops', [
    field('cooktop_type', 'Cooktop type'), number('burner_count', 'Burners / cooking zones'),
    field('surface_material', 'Surface material'), field('control_type', 'Controls / ignition'),
    field('compatible_cookware', 'Compatible cookware'), ...power, notes('safety_features', 'Safety features'),
  ]),
  template('kettles_rice_cookers', 'Kettles / rice cookers', [
    field('appliance_type', 'Appliance type'), number('capacity_litres', 'Capacity', 'l'), ...power,
    field('material', 'Body / inner pot material'), yesNo('auto_shutoff', 'Automatic shut-off'),
    yesNo('keep_warm', 'Keep warm'), notes('functions', 'Functions / controls'),
  ]),
  template('water_purifiers', 'Water purifiers', [
    field('purification_technology', 'Purification technology'), number('tank_capacity', 'Storage capacity', 'l'),
    field('purification_rate', 'Purification rate (l/h)'), field('tds_range', 'Supported input TDS'),
    number('filter_stages', 'Purification stages'), field('installation_type', 'Installation type'),
    notes('filter_maintenance', 'Filter life / maintenance'), ...power,
  ]),
  template('laptops', 'Laptops & computers', [
    field('processor', 'Processor'), number('ram', 'RAM', 'GB'), number('storage', 'Storage', 'GB'),
    field('storage_type', 'Storage type'), field('gpu', 'Graphics'), number('screen_size', 'Screen size', 'in'),
    field('resolution', 'Resolution'), field('operating_system', 'Operating system'),
    field('connectivity', 'Connectivity / ports'), field('battery_life', 'Battery life'),
  ]),
  template('power_banks', 'Power banks', [
    number('battery_capacity', 'Battery capacity', 'mAh'), number('output_power', 'Maximum output power', 'W'),
    field('ports', 'Input / output ports'), field('charging_protocols', 'Charging protocols'),
    field('battery_type', 'Battery type'), notes('safety_features', 'Safety features'),
  ]),
  template('cables_adapters', 'Cables & adapters', [
    field('connector_type', 'Connectors (input / output)'), number('cable_length', 'Cable length', 'm'),
    number('output_power', 'Supported charging power', 'W'), field('data_transfer_rate', 'Data transfer rate'),
    field('compatible_devices', 'Compatible devices'), field('material', 'Material'),
  ]),
];

function expandCatalog(structure) {
  if (!structure || !['mobile', 'electronics'].includes(structure.industry || structure.id)) return structure;
  const definitions = [...(structure.categoryDefinitions || [])];
  for (const addition of templates) {
    const index = definitions.findIndex(item => item.key === addition.key);
    if (index < 0) {
      const modelNumber = (structure.attributes || []).find(item => item.key === 'model_number');
      definitions.push(modelNumber ? { ...addition, attributes: [...addition.attributes, { ...modelNumber, required: false }] } : addition);
    }
    else {
      const saved = definitions[index];
      const keys = new Set([...(structure.attributes || []).map(item => item.key), ...(saved.attributes || []).map(item => typeof item === 'string' ? item : item.key)]);
      definitions[index] = { ...saved, attributes: [...(saved.attributes || []), ...addition.attributes.filter(item => !keys.has(item.key))] };
    }
  }
  return { ...structure, categoryDefinitions: definitions };
}

module.exports = { expandCatalog };
